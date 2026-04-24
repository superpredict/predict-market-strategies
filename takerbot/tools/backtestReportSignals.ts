/**
 * Backtest variant **(b)** rules on existing market round report CSVs using
 * `f_deribit_iv` / `g_deribit_iv` / `f_minus_g_deribit_iv`.
 * Long and short YES: **1 share** per signal, cumulative position capped at **±20** (default).
 * Long and short use the **same** filters (confidence, TTE, YES spread, sigma regime).
 * Writes a markdown summary under takerbot/reports/.
 *
 * Usage (from repo root):
 *   npm run takerbot:reportBacktest
 *   node --import tsx/esm takerbot/tools/backtestReportSignals.ts --delta 0.05 --gamma 0.03 --max-yes-shares 20
 * Optional: --min-confidence, --min-tte-ms, --max-yes-spread, --sigma-window, --sigma-min-ratio, --sigma-max-ratio
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STOP_TRADING_BEFORE_EXPIRY_MS } from '../config/constants.js';

const REPORTS_DIR = resolve(process.cwd(), 'takerbot', 'reports');

const DEFAULT_DELTA = 0.05;
const DEFAULT_GAMMA = 0.03;
const DEFAULT_MIN_CONFIDENCE = 0.18;
/** Require more than this many ms remaining (default 1 minute). */
const DEFAULT_MIN_TIME_TO_EXPIRY_MS = STOP_TRADING_BEFORE_EXPIRY_MS;
/** Max YES ask − bid (probability units) to treat book as tight enough. */
const DEFAULT_MAX_YES_SPREAD = 0.08;
/** Max cumulative long YES shares per market (and max short shares); fixed band is ±20 by default. */
const DEFAULT_MAX_YES_SHARES = 20;
/** Rolling window length for annualized_sigma median (volatility regime). */
const DEFAULT_SIGMA_MEDIAN_WINDOW = 31;
/** Current sigma must stay within [median×min, median×max]. */
const DEFAULT_SIGMA_MIN_RATIO = 0.35;
const DEFAULT_SIGMA_MAX_RATIO = 3.5;

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
  if (!Number.isInteger(maxYesShares) || maxYesShares < 1 || maxYesShares > 20) {
    throw new Error(`invalid --max-yes-shares: ${maxYesShares} (allowed 1–20)`);
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
  btcPrice: number | null;
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
    btc: idxOpt('binance_btcusdc_price'),
    strike: idx('strike_price'),
    bid: idx('yes_bid'),
    ask: idx('yes_ask'),
    f: idx('f_deribit_iv'),
    g: idx('g_deribit_iv'),
    fg: idx('f_minus_g_deribit_iv'),
    conf: idxOpt('confidence'),
    tte: idxOpt('time_to_expiry_ms'),
    sig: idxOpt('annualized_sigma_5m'),
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
    const btcParsed = I.btc !== null ? parseNum(cols[I.btc]!) : null;
    rows.push({
      isoTime: cols[I.iso]!,
      ts: Number(cols[I.ts]),
      fairValue: Number(cols[I.fv]),
      chainlinkPrice: Number(cols[I.cl]),
      btcPrice: btcParsed,
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
  settlementPrice: number;
  yesPayoff: 0 | 1;
  fills: BuyFill[];
  totalShares: number;
  totalCost: number;
  pnl: number;
}

interface ShortFill {
  entryRowIndex: number;
  entryIso: string;
  entryYesBid: number;
  f: number;
  g: number;
  fMinusG: number;
  confidence: number;
}

interface ShortScaledResult {
  slug: string;
  sourceCsv: string;
  strike: number;
  settlementPrice: number;
  yesPayoff: 0 | 1;
  fills: ShortFill[];
  totalShares: number;
  totalCredit: number;
  pnl: number;
}

interface BacktestFileOutcome {
  strike: number | null;
  settlementPrice: number | null;
  yesPayoff: 0 | 1 | null;
  buyScaled: BuyScaledResult | null;
  shortScaled: ShortScaledResult | null;
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
      settlementPrice: null,
      yesPayoff: null,
      buyScaled: null,
      shortScaled: null,
      skipReason: 'empty CSV',
    };
  }

  const strike = rows.find((r) => r.strikePrice !== null && r.strikePrice > 0)?.strikePrice ?? null;
  if (strike === null || strike <= 0) {
    return {
      strike: null,
      settlementPrice: null,
      yesPayoff: null,
      buyScaled: null,
      shortScaled: null,
      skipReason: 'no positive strike_price',
    };
  }

  const last = rows[rows.length - 1]!;
  const settlementPx =
    last.btcPrice !== null && last.btcPrice > 0 && Number.isFinite(last.btcPrice)
      ? last.btcPrice
      : last.chainlinkPrice;
  const yesPayoff = yesPayoffAtExpiry(settlementPx, strike);

  const buyFills: BuyFill[] = [];
  let positionYes = 0;

  const shortFills: ShortFill[] = [];
  let positionShort = 0;

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

    if (buySignal && spreadOk && confOk && tteOk && volOk && room > 0) {
      const qty = 1;
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

    const sellOk =
      r.f <= -args.delta &&
      r.fMinusG <= -args.gamma &&
      r.yesBid > 0 &&
      Number.isFinite(r.yesBid);

    const roomShort = args.maxYesShares - positionShort;
    if (sellOk && spreadOk && confOk && tteOk && volOk && roomShort > 0) {
      shortFills.push({
        entryRowIndex: i,
        entryIso: r.isoTime,
        entryYesBid: r.yesBid,
        f: r.f,
        g: r.g,
        fMinusG: r.fMinusG,
        confidence: r.confidence!,
      });
      positionShort += 1;
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
      settlementPrice: settlementPx,
      yesPayoff,
      fills: buyFills,
      totalShares,
      totalCost,
      pnl,
    };
  }

  let shortScaled: ShortScaledResult | null = null;
  if (shortFills.length > 0) {
    const totalShares = shortFills.length;
    const totalCredit = shortFills.reduce((s, f) => s + f.entryYesBid, 0);
    const pnl = totalCredit - yesPayoff * totalShares;
    shortScaled = {
      slug,
      sourceCsv,
      strike,
      settlementPrice: settlementPx,
      yesPayoff,
      fills: shortFills,
      totalShares,
      totalCredit,
      pnl,
    };
  }

  return {
    strike,
    settlementPrice: settlementPx,
    yesPayoff,
    buyScaled,
    shortScaled,
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
  settlementPrice: number | null;
  yesPayoff: 0 | 1 | null;
  buyScaled: BuyScaledResult | null;
  shortScaled: ShortScaledResult | null;
  skipReason: string | null;
}

function buildMarkdown(args: CliArgs, results: MarketRow[], outputName: string): string {
  const lines: string[] = [];
  lines.push(`# Report backtest (variant **(b)**): f_deribit_iv / g_deribit_iv / f_minus_g_deribit_iv`);
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- output: \`takerbot/reports/${outputName}\``);
  lines.push(`- source reports: all \`*.csv\` in reports dir (excluding names starting with \`backtest-\`)`);
  lines.push('');

  lines.push('## Assumptions (read carefully)');
  lines.push('');
  lines.push(
    '1. **Variant (b)** — Signals use CSV columns `f_deribit_iv`, `g_deribit_iv`, and `f_minus_g_deribit_iv` (Deribit mark-IV fair value minus YES ask), matching the round report definition.',
  );
  lines.push(
    '2. **`g` in CSV** — Produced by the round report as the mean of the **previous** 10 `f` samples (`g(t) = average(f(t−1)…f(t−10))`); a row is eligible only when `g` and `f_minus_g` are non-blank.',
  );
  lines.push(
    '3. **Long YES** — Each qualifying row adds **exactly 1** share; cumulative long size is capped at `--max-yes-shares` (max **20**).',
  );
  lines.push(
    '4. **Short YES** — Each qualifying row adds **exactly 1** short share; cumulative short size uses the **same** cap (independent long/short books, not netted).',
  );
  lines.push('5. **Hold to settlement** — No interim exit; long PnL is `yesPayoff × totalShares − sum(yes_ask)`; short PnL is `sum(yes_bid) − yesPayoff × totalShares`.');
  lines.push(
    '6. **YES payoff** — `yesPayoff = 1` if settlement spot **strictly exceeds** strike `K`, else `0` (same strike rule as before).',
  );
  lines.push(
    '7. **Settlement price proxy** — `btc_price` on the **last** CSV row when present (Binance mid in new reports); otherwise `chainlink_price`.',
  );
  lines.push('8. **Strike** — From `strike_price` (first positive); else file skipped.');
  lines.push(
    '9. **Shared filters (long and short)** — In addition to the respective `f` / `f−g` sign rules: `confidence ≥ minConfidence`; `time_to_expiry_ms > minTte`; YES spread `yes_ask − yes_bid ≤ maxYesSpread`; `annualized_sigma` within `[median×minRatio, median×maxRatio]` over a trailing window.',
  );
  lines.push('10. **Fees, funding, borrow, latency** — Ignored. Slippage beyond bid/ask columns ignored.');
  lines.push('11. **Overlapping long and short** — Backtested **independently** (not netted).');
  lines.push(
    '12. **Optional CSV columns** — If `confidence`, `time_to_expiry_ms`, or `annualized_sigma` are missing from the header, **both** long and short adds are effectively disabled (filters never pass).',
  );
  lines.push('');

  lines.push('## Rule definitions');
  lines.push('');
  lines.push(
    '- **Buy YES (+1 sh)** when: `g` defined, `f ≥ δ`, `f − g ≥ γ`, plus the shared filters in assumption 9.',
  );
  lines.push(
    '- **Sell YES (+1 short sh)** when: `g` defined, `f ≤ −δ`, `f − g ≤ −γ`, plus the **same** shared filters in assumption 9, and room under the position cap.',
  );
  lines.push('');

  lines.push('## Parameters used in this run');
  lines.push('');
  lines.push(`- \`δ\` (delta): **${args.delta}**`);
  lines.push(`- \`γ\` (gamma): **${args.gamma}**`);
  lines.push(`- min confidence: **${args.minConfidence}**`);
  lines.push(`- min time-to-expiry (ms): **${args.minTimeToExpiryMs}** (must be **strictly greater** than this)`);
  lines.push(`- max YES spread (ask−bid): **${args.maxYesSpread}**`);
  lines.push(`- max cumulative shares per side (long cap / short cap): **${args.maxYesShares}** (fixed band ±20 when using defaults)`);
  lines.push(`- sigma median window: **${args.sigmaMedianWindow}**, ratio band: **[${args.sigmaMinRatio}, ${args.sigmaMaxRatio}]× median**`);
  lines.push(`- reports directory: \`${args.reportsDir}\``);
  lines.push('');

  lines.push('## Per-market results');
  lines.push('');
  lines.push(
    '| source CSV | strike | settlement | YES payoff | long sh | long cost | long PnL | #L | short sh | short PnL | #S | first long | first short |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');

  let sumBuy = 0;
  let nBuyMkts = 0;
  let sumShort = 0;
  let nShortMkts = 0;

  for (const m of results) {
    const bs = m.buyScaled;
    const ss = m.shortScaled;
    if (bs) {
      sumBuy += bs.pnl;
      nBuyMkts += 1;
    }
    if (ss) {
      sumShort += ss.pnl;
      nShortMkts += 1;
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
          '—',
        ].join(' | '),
      );
      continue;
    }
    const strike = m.strike!;
    const setPx = m.settlementPrice!;
    const yp = m.yesPayoff!;
    const firstLong = bs && bs.fills[0] ? bs.fills[0].entryIso : '—';
    const firstShort = ss && ss.fills[0] ? ss.fills[0].entryIso : '—';
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
        ss ? String(ss.totalShares) : '0',
        ss ? formatMoney(ss.pnl) : '—',
        ss ? String(ss.fills.length) : '0',
        firstLong,
        firstShort,
      ].join(' | '),
    );
  }

  lines.push('');
  lines.push('## Aggregate (over markets with a fill)');
  lines.push('');
  lines.push(
    `- long: **${nBuyMkts}** markets with ≥1 add, sum PnL: **${formatMoney(sumBuy)}**, avg/market: **${nBuyMkts ? formatMoney(sumBuy / nBuyMkts) : 'n/a'}**`,
  );
  lines.push(
    `- short: **${nShortMkts}** markets with ≥1 short add, sum PnL: **${formatMoney(sumShort)}**, avg/market: **${nShortMkts ? formatMoney(sumShort / nShortMkts) : 'n/a'}**`,
  );
  lines.push('');

  lines.push('## Detail: long adds per file (+1 sh each)');
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

  lines.push('## Detail: short adds per file (+1 sh each)');
  lines.push('');
  for (const m of results) {
    const ss = m.shortScaled;
    if (m.skipReason !== null) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **skipped** (${m.skipReason})`);
      continue;
    }
    if (!ss || ss.fills.length === 0) {
      lines.push(`- \`${m.source}\` / ${m.slug}: **no short fills**`);
      continue;
    }
    lines.push(
      `- \`${m.source}\` / ${m.slug}: **${ss.fills.length}** short add(s), credit **${formatMoney(ss.totalCredit)}** → PnL **${formatMoney(ss.pnl)}** (payoff ${ss.yesPayoff} per sh)`,
    );
    for (const f of ss.fills) {
      lines.push(
        `  - \`${f.entryIso}\`  bid **${f.entryYesBid.toFixed(6)}**  conf=${f.confidence.toFixed(4)}  ` +
          `f=${f.f.toFixed(6)} g=${f.g.toFixed(6)} f−g=${f.fMinusG.toFixed(6)}`,
      );
    }
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
      settlementPrice: out.settlementPrice,
      yesPayoff: out.yesPayoff,
      buyScaled: out.buyScaled,
      shortScaled: out.shortScaled,
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
