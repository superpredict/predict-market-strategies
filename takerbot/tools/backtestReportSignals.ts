/**
 * Backtest simple (a)-variant f / g / f−g rules on existing market round report CSVs.
 * Long YES supports multiple adds with dynamic size, confidence / TTE / spread / vol / cap filters.
 * Writes a markdown summary under takerbot/reports/.
 *
 * Usage (from repo root):
 *   npm run takerbot:reportBacktest
 *   node --import tsx/esm takerbot/tools/backtestReportSignals.ts --delta 0.02 --gamma 0.01 --max-yes-shares 10
 * Optional: --min-confidence, --min-tte-ms, --max-yes-spread, --sigma-window, --sigma-min-ratio, --sigma-max-ratio
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPORTS_DIR = resolve(process.cwd(), 'takerbot', 'reports');

const DEFAULT_DELTA = 0.02;
const DEFAULT_GAMMA = 0.01;
const DEFAULT_MIN_CONFIDENCE = 0.18;
/** Require more than this many ms remaining (default 3 minutes). */
const DEFAULT_MIN_TIME_TO_EXPIRY_MS = 3 * 60 * 1000;
/** Max YES ask − bid (probability units) to treat book as tight enough. */
const DEFAULT_MAX_YES_SPREAD = 0.08;
/** Max cumulative long YES shares per market (scaled adds). */
const DEFAULT_MAX_YES_SHARES = 10;
/** Rolling window length for annualized_sigma median (volatility regime). */
const DEFAULT_SIGMA_MEDIAN_WINDOW = 31;
/** Current sigma must stay within [median×min, median×max]. */
const DEFAULT_SIGMA_MIN_RATIO = 0.35;
const DEFAULT_SIGMA_MAX_RATIO = 3.5;

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface CliArgs {
  delta: number;
  gamma: number;
  reportsDir: string;
  minConfidence: number;
  minTimeToExpiryMs: number;
  maxYesSpread: number;
  maxYesShares: number;
  sigmaMedianWindow: number;
  sigmaMinRatio: number;
  sigmaMaxRatio: number;
}

function parseArgs(argv: string[]): CliArgs {
  let delta = DEFAULT_DELTA;
  let gamma = DEFAULT_GAMMA;
  let reportsDir = REPORTS_DIR;
  let minConfidence = DEFAULT_MIN_CONFIDENCE;
  let minTimeToExpiryMs = DEFAULT_MIN_TIME_TO_EXPIRY_MS;
  let maxYesSpread = DEFAULT_MAX_YES_SPREAD;
  let maxYesShares = DEFAULT_MAX_YES_SHARES;
  let sigmaMedianWindow = DEFAULT_SIGMA_MEDIAN_WINDOW;
  let sigmaMinRatio = DEFAULT_SIGMA_MIN_RATIO;
  let sigmaMaxRatio = DEFAULT_SIGMA_MAX_RATIO;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delta' && argv[i + 1]) {
      delta = Number(argv[++i]);
    } else if (a === '--gamma' && argv[i + 1]) {
      gamma = Number(argv[++i]);
    } else if (a === '--reports-dir' && argv[i + 1]) {
      reportsDir = resolve(argv[++i]!);
    } else if (a === '--min-confidence' && argv[i + 1]) {
      minConfidence = Number(argv[++i]);
    } else if (a === '--min-tte-ms' && argv[i + 1]) {
      minTimeToExpiryMs = Number(argv[++i]);
    } else if (a === '--max-yes-spread' && argv[i + 1]) {
      maxYesSpread = Number(argv[++i]);
    } else if (a === '--max-yes-shares' && argv[i + 1]) {
      maxYesShares = Number(argv[++i]);
    } else if (a === '--sigma-window' && argv[i + 1]) {
      sigmaMedianWindow = Number(argv[++i]);
    } else if (a === '--sigma-min-ratio' && argv[i + 1]) {
      sigmaMinRatio = Number(argv[++i]);
    } else if (a === '--sigma-max-ratio' && argv[i + 1]) {
      sigmaMaxRatio = Number(argv[++i]);
    }
  }
  if (!Number.isFinite(delta) || delta < 0) throw new Error(`invalid --delta: ${delta}`);
  if (!Number.isFinite(gamma) || gamma < 0) throw new Error(`invalid --gamma: ${gamma}`);
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`invalid --min-confidence: ${minConfidence}`);
  }
  if (!Number.isFinite(minTimeToExpiryMs) || minTimeToExpiryMs < 0) {
    throw new Error(`invalid --min-tte-ms: ${minTimeToExpiryMs}`);
  }
  if (!Number.isFinite(maxYesSpread) || maxYesSpread <= 0) {
    throw new Error(`invalid --max-yes-spread: ${maxYesSpread}`);
  }
  if (!Number.isInteger(maxYesShares) || maxYesShares < 1) {
    throw new Error(`invalid --max-yes-shares: ${maxYesShares}`);
  }
  if (!Number.isInteger(sigmaMedianWindow) || sigmaMedianWindow < 5) {
    throw new Error(`invalid --sigma-window: ${sigmaMedianWindow}`);
  }
  if (!Number.isFinite(sigmaMinRatio) || sigmaMinRatio <= 0 || sigmaMinRatio > 1) {
    throw new Error(`invalid --sigma-min-ratio: ${sigmaMinRatio}`);
  }
  if (!Number.isFinite(sigmaMaxRatio) || sigmaMaxRatio < 1) {
    throw new Error(`invalid --sigma-max-ratio: ${sigmaMaxRatio}`);
  }
  return {
    delta,
    gamma,
    reportsDir,
    minConfidence,
    minTimeToExpiryMs,
    maxYesSpread,
    maxYesShares,
    sigmaMedianWindow,
    sigmaMinRatio,
    sigmaMaxRatio,
  };
}

interface CsvRow {
  isoTime: string;
  ts: number;
  fairValue: number;
  chainlinkPrice: number;
  strikePrice: number | null;
  yesBid: number;
  yesAsk: number;
  f: number;
  g: number | null;
  fMinusG: number | null;
  confidence: number | null;
  timeToExpiryMs: number | null;
  annualizedSigma: number | null;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0]!.split(',');
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV missing column ${name}`);
    return i;
  };
  const idxOpt = (name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? null : i;
  };
  const I = {
    iso: idx('iso_time'),
    ts: idx('ts'),
    fv: idx('fair_value'),
    cl: idx('chainlink_price'),
    strike: idx('strike_price'),
    bid: idx('yes_bid'),
    ask: idx('yes_ask'),
    f: idx('f'),
    g: idx('g'),
    fg: idx('f_minus_g'),
    conf: idxOpt('confidence'),
    tte: idxOpt('time_to_expiry_ms'),
    sig: idxOpt('annualized_sigma'),
  };

  const rows: CsvRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li]!.split(',');
    if (cols.length < header.length) continue;
    const strike = parseNum(cols[I.strike]!);
    const g = parseNum(cols[I.g]!);
    const fg = parseNum(cols[I.fg]!);
    const conf = I.conf !== null ? parseNum(cols[I.conf]!) : null;
    const tte = I.tte !== null ? parseNum(cols[I.tte]!) : null;
    const sig = I.sig !== null ? parseNum(cols[I.sig]!) : null;
    rows.push({
      isoTime: cols[I.iso]!,
      ts: Number(cols[I.ts]),
      fairValue: Number(cols[I.fv]),
      chainlinkPrice: Number(cols[I.cl]),
      strikePrice: strike,
      yesBid: Number(cols[I.bid]),
      yesAsk: Number(cols[I.ask]),
      f: Number(cols[I.f]),
      g,
      fMinusG: fg,
      confidence: conf,
      timeToExpiryMs: tte,
      annualizedSigma: sig,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function yesPayoffAtExpiry(chainlink: number, strike: number): 0 | 1 {
  return chainlink > strike ? 1 : 0;
}

interface BuyFill {
  entryRowIndex: number;
  entryIso: string;
  qty: number;
  entryYesAsk: number;
  f: number;
  g: number;
  fMinusG: number;
  confidence: number;
}

interface BuyScaledResult {
  slug: string;
  sourceCsv: string;
  strike: number;
  settlementChainlink: number;
  yesPayoff: 0 | 1;
  fills: BuyFill[];
  totalShares: number;
  totalCost: number;
  pnl: number;
}

interface TradeResult {
  slug: string;
  sourceCsv: string;
  strike: number;
  settlementChainlink: number;
  yesPayoff: 0 | 1;
  /** First row index (0-based in sorted rows) where signal fired */
  entryRowIndex: number;
  entryIso: string;
  entryYesAsk?: number;
  entryYesBid?: number;
  f: number;
  g: number;
  fMinusG: number;
  pnl: number;
}

interface BacktestFileOutcome {
  strike: number | null;
  settlementChainlink: number | null;
  yesPayoff: 0 | 1 | null;
  buyScaled: BuyScaledResult | null;
  sell: TradeResult | null;
  skipReason: string | null;
}

function sigmaRegimeOk(
  rows: CsvRow[],
  i: number,
  window: number,
  minRatio: number,
  maxRatio: number,
): boolean {
  const row = rows[i];
  const cur = row?.annualizedSigma;
  if (cur === null || cur === undefined || !Number.isFinite(cur) || cur <= 0) return false;
  const lo = Math.max(0, i - window + 1);
  const hist: number[] = [];
  for (let j = lo; j <= i; j++) {
    const s = rows[j]?.annualizedSigma;
    if (s !== null && s !== undefined && Number.isFinite(s) && s > 0) hist.push(s);
  }
  const minSamples = Math.min(5, Math.max(3, Math.floor(window / 6)));
  if (hist.length < minSamples) return false;
  const med = median(hist);
  if (!Number.isFinite(med) || med <= 0) return false;
  return cur >= med * minRatio && cur <= med * maxRatio;
}

/** Shares to add this signal; larger when confidence / edge headroom is higher. */
function dynamicBuyQty(
  confidence: number,
  minConfidence: number,
  f: number,
  delta: number,
  fMinusG: number,
  gamma: number,
  room: number,
): number {
  if (room <= 0) return 0;
  const confHead = clamp01((confidence - minConfidence) / Math.max(1e-9, 1 - minConfidence));
  const fHead = clamp01((f - delta) / 0.08);
  const fgHead = clamp01((fMinusG - gamma) / 0.05);
  const score = clamp01(confHead * 0.65 + fHead * 0.175 + fgHead * 0.175);
  const capThisFill = Math.min(room, 5);
  const qty = Math.max(1, Math.min(room, Math.round(1 + score * (capThisFill - 1))));
  return qty;
}

function runBacktestOnRows(
  slug: string,
  sourceCsv: string,
  rows: CsvRow[],
  args: Pick<
    CliArgs,
    | 'delta'
    | 'gamma'
    | 'minConfidence'
    | 'minTimeToExpiryMs'
    | 'maxYesSpread'
    | 'maxYesShares'
    | 'sigmaMedianWindow'
    | 'sigmaMinRatio'
    | 'sigmaMaxRatio'
  >,
): BacktestFileOutcome {
  if (rows.length === 0) {
    return {
      strike: null,
      settlementChainlink: null,
      yesPayoff: null,
      buyScaled: null,
      sell: null,
      skipReason: 'empty CSV',
    };
  }

  const strike = rows.find((r) => r.strikePrice !== null && r.strikePrice > 0)?.strikePrice ?? null;
  if (strike === null || strike <= 0) {
    return {
      strike: null,
      settlementChainlink: null,
      yesPayoff: null,
      buyScaled: null,
      sell: null,
      skipReason: 'no positive strike_price',
    };
  }

  const last = rows[rows.length - 1];
  const settlementPx = last!.chainlinkPrice;
  const yesPayoff = yesPayoffAtExpiry(settlementPx, strike);

  const buyFills: BuyFill[] = [];
  let positionYes = 0;

  let sell: TradeResult | null = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === undefined) continue;
    if (r.g === null || r.fMinusG === null) continue;

    const buySignal =
      r.f >= args.delta &&
      r.fMinusG >= args.gamma &&
      r.yesAsk > 0 &&
      Number.isFinite(r.yesAsk);

    const spread = r.yesAsk - r.yesBid;
    const spreadOk =
      r.yesBid > 0 &&
      Number.isFinite(r.yesBid) &&
      Number.isFinite(spread) &&
      spread >= 0 &&
      spread <= args.maxYesSpread;

    const confOk = r.confidence !== null && Number.isFinite(r.confidence) && r.confidence >= args.minConfidence;

    const tteOk =
      r.timeToExpiryMs !== null &&
      Number.isFinite(r.timeToExpiryMs) &&
      r.timeToExpiryMs > args.minTimeToExpiryMs;

    const volOk = sigmaRegimeOk(
      rows,
      i,
      args.sigmaMedianWindow,
      args.sigmaMinRatio,
      args.sigmaMaxRatio,
    );

    const room = args.maxYesShares - positionYes;

    if (
      buySignal &&
      spreadOk &&
      confOk &&
      tteOk &&
      volOk &&
      room > 0
    ) {
      const qty = dynamicBuyQty(
        r.confidence!,
        args.minConfidence,
        r.f,
        args.delta,
        r.fMinusG!,
        args.gamma,
        room,
      );
      if (qty > 0) {
        buyFills.push({
          entryRowIndex: i,
          entryIso: r.isoTime,
          qty,
          entryYesAsk: r.yesAsk,
          f: r.f,
          g: r.g,
          fMinusG: r.fMinusG,
          confidence: r.confidence!,
        });
        positionYes += qty;
      }
    }

    const sellOk =
      r.f <= -args.delta &&
      r.fMinusG <= -args.gamma &&
      r.yesBid > 0 &&
      Number.isFinite(r.yesBid);

    if (sellOk && sell === null) {
      const pnl = r.yesBid - yesPayoff;
      sell = {
        slug,
        sourceCsv,
        strike,
        settlementChainlink: settlementPx,
        yesPayoff,
        entryRowIndex: i,
        entryIso: r.isoTime,
        entryYesBid: r.yesBid,
        f: r.f,
        g: r.g,
        fMinusG: r.fMinusG,
        pnl,
      };
    }
  }

  let buyScaled: BuyScaledResult | null = null;
  if (buyFills.length > 0) {
    const totalShares = buyFills.reduce((s, f) => s + f.qty, 0);
    const totalCost = buyFills.reduce((s, f) => s + f.qty * f.entryYesAsk, 0);
    const pnl = yesPayoff * totalShares - totalCost;
    buyScaled = {
      slug,
      sourceCsv,
      strike,
      settlementChainlink: settlementPx,
      yesPayoff,
      fills: buyFills,
      totalShares,
      totalCost,
      pnl,
    };
  }

  return {
    strike,
    settlementChainlink: settlementPx,
    yesPayoff,
    buyScaled,
    sell,
    skipReason: null,
  };
}

function formatMoney(x: number): string {
  return x.toFixed(6);
}

interface MarketRow {
  slug: string;
  source: string;
  strike: number | null;
  settlementChainlink: number | null;
  yesPayoff: 0 | 1 | null;
  buyScaled: BuyScaledResult | null;
  sell: TradeResult | null;
  skipReason: string | null;
}

function buildMarkdown(args: CliArgs, results: MarketRow[], outputName: string): string {
  const lines: string[] = [];
  lines.push(`# Report backtest (variant **(a)**): f / g / f−g`);
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- output: \`takerbot/reports/${outputName}\``);
  lines.push(`- source reports: all \`*.csv\` in reports dir (excluding names starting with \`backtest-\`)`);
  lines.push('');

  lines.push('## Assumptions (read carefully)');
  lines.push('');
  lines.push('1. **Variant (a) only** — Signals use CSV columns `f`, `g`, and `f_minus_g` where `f = fair_value − yes_ask` (EWMA σ fair value), matching the round report definition.');
  lines.push('2. **Rolling `g`** — A row is eligible only when `g` and `f_minus_g` are present (the 5-sample moving average is defined; same as the report).');
  lines.push('3. **Long YES: multiple adds** — Each row is evaluated in ascending `ts`. Whenever the buy rule holds **and** the extra risk filters pass, a **dynamic** number of shares (1 up to min(5, room)) is added; cumulative size is capped at `--max-yes-shares`.');
  lines.push('4. **Short YES** — Still **one** 1-share short leg per file: first row satisfying the sell rule (unchanged baseline).');
  lines.push('5. **Hold to settlement** — No interim exit; long PnL is `yesPayoff × totalShares − sum(qty × yes_ask)` over all adds.');
  lines.push('6. **YES payoff** — `yesPayoff = 1` if settlement Chainlink **strictly exceeds** strike `K`, else `0`.');
  lines.push('7. **Settlement price proxy** — `chainlink_price` on the **last** CSV row.');
  lines.push('8. **Strike** — From `strike_price` (first positive); else file skipped.');
  lines.push('9. **Long filters** — In addition to `f` / `f−g`: `confidence ≥ minConfidence`; `time_to_expiry_ms > minTte`; YES spread `yes_ask − yes_bid ≤ maxYesSpread`; `annualized_sigma` within `[median×minRatio, median×maxRatio]` over a trailing window (needs enough sigma samples).');
  lines.push('10. **Fees, funding, borrow, latency** — Ignored. Slippage beyond bid/ask columns ignored.');
  lines.push('11. **Overlapping long and short** — Backtested **independently** (not netted).');
  lines.push('12. **Optional CSV columns** — If `confidence`, `time_to_expiry_ms`, or `annualized_sigma` are missing from the header, long adds are effectively disabled (filters never pass).');
  lines.push('');

  lines.push('## Rule definitions');
  lines.push('');
  lines.push('- **Buy YES (each add)** when: `g` defined, `f ≥ δ`, `f − g ≥ γ`, plus the long filters in assumption 9.');
  lines.push('- **Sell YES (short)** when: `g` defined, `f ≤ −δ`, `f − g ≤ −γ` (first hit only, 1 share).');
  lines.push('');

  lines.push('## Parameters used in this run');
  lines.push('');
  lines.push(`- \`δ\` (delta): **${args.delta}**`);
  lines.push(`- \`γ\` (gamma): **${args.gamma}**`);
  lines.push(`- min confidence: **${args.minConfidence}**`);
  lines.push(`- min time-to-expiry (ms): **${args.minTimeToExpiryMs}** (must be **strictly greater** than this)`);
  lines.push(`- max YES spread (ask−bid): **${args.maxYesSpread}**`);
  lines.push(`- max cumulative YES shares (long): **${args.maxYesShares}**`);
  lines.push(`- sigma median window: **${args.sigmaMedianWindow}**, ratio band: **[${args.sigmaMinRatio}, ${args.sigmaMaxRatio}]× median**`);
  lines.push(`- reports directory: \`${args.reportsDir}\``);
  lines.push('');

  lines.push('## Per-market results');
  lines.push('');
  lines.push(
    '| source CSV | strike | settlement CL | YES payoff | long shares | long cost | long PnL | # long adds | sell @ bid | sell PnL | first long | first short |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');

  let sumBuy = 0;
  let nBuyMkts = 0;
  let sumSell = 0;
  let nSell = 0;

  for (const m of results) {
    const bs = m.buyScaled;
    const s = m.sell;
    if (bs) {
      sumBuy += bs.pnl;
      nBuyMkts += 1;
    }
    if (s) {
      sumSell += s.pnl;
      nSell += 1;
    }
    if (m.skipReason !== null) {
      lines.push(
        [
          `\`${m.source}\` (${m.skipReason})`,
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
          '—',
        ].join(' | '),
      );
      continue;
    }
    const strike = m.strike!;
    const setPx = m.settlementChainlink!;
    const yp = m.yesPayoff!;
    const firstLong = bs && bs.fills[0] ? bs.fills[0].entryIso : '—';
    const firstShort = s ? s.entryIso : '—';
    lines.push(
      [
        `\`${m.source}\``,
        strike.toFixed(2),
        setPx.toFixed(2),
        String(yp),
        bs ? String(bs.totalShares) : '0',
        bs ? formatMoney(bs.totalCost) : '—',
        bs ? formatMoney(bs.pnl) : '—',
        bs ? String(bs.fills.length) : '0',
        s ? s.entryYesBid!.toFixed(6) : '—',
        s ? formatMoney(s.pnl) : '—',
        firstLong,
        firstShort,
      ].join(' | '),
    );
  }

  lines.push('');
  lines.push('## Aggregate (over markets with a fill)');
  lines.push('');
  lines.push(
    `- long (scaled): **${nBuyMkts}** markets with ≥1 add, sum PnL: **${formatMoney(sumBuy)}**, avg/market: **${nBuyMkts ? formatMoney(sumBuy / nBuyMkts) : 'n/a'}**`,
  );
  lines.push(`- sell legs: **${nSell}**, sum PnL: **${formatMoney(sumSell)}**, avg: **${nSell ? formatMoney(sumSell / nSell) : 'n/a'}**`);
  lines.push('');

  lines.push('## Detail: scaled long adds per file');
  lines.push('');
  for (const m of results) {
    const bs = m.buyScaled;
    if (m.skipReason !== null) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **skipped** (${m.skipReason})`);
      continue;
    }
    if (!bs || bs.fills.length === 0) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **no long fills**`);
      continue;
    }
    lines.push(
      `- \`${m.source}\` / ${m.slug}: **${bs.fills.length}** add(s), **${bs.totalShares}** sh, cost **${formatMoney(bs.totalCost)}** → PnL **${formatMoney(bs.pnl)}** (payoff ${bs.yesPayoff} per sh)`,
    );
    for (const f of bs.fills) {
      lines.push(
        `  - \`${f.entryIso}\`  +${f.qty} @ **${f.entryYesAsk.toFixed(6)}**  conf=${f.confidence.toFixed(4)}  ` +
          `f=${f.f.toFixed(6)} g=${f.g.toFixed(6)} f−g=${f.fMinusG.toFixed(6)}`,
      );
    }
  }
  lines.push('');

  lines.push('## Detail: first short per file (if any)');
  lines.push('');
  for (const m of results) {
    const s = m.sell;
    if (m.skipReason !== null) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **skipped** (${m.skipReason})`);
      continue;
    }
    if (!s) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **no sell signal**`);
      continue;
    }
    lines.push(
      `- \`${m.source}\` / ${m.slug}: time \`${s.entryIso}\`, bid **${s.entryYesBid}**, ` +
        `f=${s.f.toFixed(6)} g=${s.g.toFixed(6)} f−g=${s.fMinusG.toFixed(6)} → PnL **${formatMoney(s.pnl)}** (payoff ${s.yesPayoff})`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const names = await readdir(args.reportsDir);
  const csvNames = names.filter(
    (n) => n.endsWith('.csv') && !n.startsWith('backtest-'),
  );
  csvNames.sort();

  const bundle: MarketRow[] = [];

  for (const name of csvNames) {
    const path = resolve(args.reportsDir, name);
    const raw = await readFile(path, 'utf8');
    const rows = parseCsv(raw);
    const slug = name.replace(/\.csv$/i, '');
    const out = runBacktestOnRows(slug, name, rows, args);
    bundle.push({
      slug,
      source: name,
      strike: out.strike,
      settlementChainlink: out.settlementChainlink,
      yesPayoff: out.yesPayoff,
      buyScaled: out.buyScaled,
      sell: out.sell,
      skipReason: out.skipReason,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outName = `backtest-fg-a-${stamp}.md`;
  const outPath = resolve(args.reportsDir, outName);
  const md = buildMarkdown(args, bundle, outName);
  await writeFile(outPath, `${md}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
