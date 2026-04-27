/**
 * Backtest report signals on existing market round report CSVs.
 *
 * Runs three variants in one execution and writes one combined markdown report:
 * - (a): sigma_5m track
 * - (b): sigma_10m track
 * - (c): deribit_iv track
 *
 * The output includes per-variant summaries and side-by-side comparison.
 *
 * Long and short YES: 1 share per signal; cumulative position capped at ±20 by default.
 * Long and short use the same execution filters (trade signal + TTE + spread + sigma regime).
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

type VariantKey = 'a' | 'b' | 'c';

interface VariantConfig {
  key: VariantKey;
  title: string;
  signalColumn: string;
  fColumn: string;
  gColumn: string;
  fMinusGColumn: string;
}

const VARIANT_CONFIGS: VariantConfig[] = [
  {
    key: 'a',
    title: 'sigma_5m',
    signalColumn: 'trade_signal_sigma_5m',
    fColumn: 'f_sigma_5m',
    gColumn: 'g_sigma_5m',
    fMinusGColumn: 'f_minus_g_sigma_5m',
  },
  {
    key: 'b',
    title: 'sigma_10m',
    signalColumn: 'trade_signal_sigma_10m',
    fColumn: 'f_sigma_10m',
    gColumn: 'g_sigma_10m',
    fMinusGColumn: 'f_minus_g_sigma_10m',
  },
  {
    key: 'c',
    title: 'deribit_iv',
    signalColumn: 'trade_signal_deribit_iv',
    fColumn: 'f_deribit_iv',
    gColumn: 'g_deribit_iv',
    fMinusGColumn: 'f_minus_g_deribit_iv',
  },
];

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
  chainlinkPrice: number;
  btcPrice: number | null;
  strikePrice: number | null;
  yesBid: number;
  yesAsk: number;
  fSigma5m: number | null;
  gSigma5m: number | null;
  fMinusGSigma5m: number | null;
  fSigma10m: number | null;
  gSigma10m: number | null;
  fMinusGSigma10m: number | null;
  fDeribitIv: number | null;
  gDeribitIv: number | null;
  fMinusGDeribitIv: number | null;
  timeToExpiryMs: number | null;
  annualizedSigma5m: number | null;
  tradeSignalSigma5m: -1 | 0 | 1 | null;
  tradeSignalSigma10m: -1 | 0 | 1 | null;
  tradeSignalDeribitIv: -1 | 0 | 1 | null;
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
  const I = {
    iso: idx('iso_time'),
    ts: idx('fair_value_redis_ts'),
    cl: idx('chainlink_price'),
    btc: idx('binance_btcusdc_price'),
    strike: idx('strike_price'),
    bid: idx('yes_bid'),
    ask: idx('yes_ask'),
    f5: idx('f_sigma_5m'),
    g5: idx('g_sigma_5m'),
    fg5: idx('f_minus_g_sigma_5m'),
    f10: idx('f_sigma_10m'),
    g10: idx('g_sigma_10m'),
    fg10: idx('f_minus_g_sigma_10m'),
    fDeribit: idx('f_deribit_iv'),
    gDeribit: idx('g_deribit_iv'),
    fgDeribit: idx('f_minus_g_deribit_iv'),
    signal5: idx('trade_signal_sigma_5m'),
    signal10: idx('trade_signal_sigma_10m'),
    signal: idx('trade_signal_deribit_iv'),
    tte: idx('time_to_expiry_ms'),
    sig5: idx('annualized_sigma_5m'),
  };

  const rows: CsvRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li]!.split(',');
    if (cols.length < header.length) continue;
    const strike = parseNum(cols[I.strike]!);
    const g5 = parseNum(cols[I.g5]!);
    const fg5 = parseNum(cols[I.fg5]!);
    const g10 = parseNum(cols[I.g10]!);
    const fg10 = parseNum(cols[I.fg10]!);
    const gDeribit = parseNum(cols[I.gDeribit]!);
    const fgDeribit = parseNum(cols[I.fgDeribit]!);
    const tte = parseNum(cols[I.tte]!);
    const sig5 = parseNum(cols[I.sig5]!);
    const btcParsed = parseNum(cols[I.btc]!);
    const signal5 = parseNum(cols[I.signal5]!);
    const signal10 = parseNum(cols[I.signal10]!);
    const signal = parseNum(cols[I.signal]!);
    rows.push({
      isoTime: cols[I.iso]!,
      ts: Number(cols[I.ts]),
      chainlinkPrice: Number(cols[I.cl]),
      btcPrice: btcParsed,
      strikePrice: strike,
      yesBid: Number(cols[I.bid]),
      yesAsk: Number(cols[I.ask]),
      fSigma5m: parseNum(cols[I.f5]!),
      gSigma5m: g5,
      fMinusGSigma5m: fg5,
      fSigma10m: parseNum(cols[I.f10]!),
      gSigma10m: g10,
      fMinusGSigma10m: fg10,
      fDeribitIv: parseNum(cols[I.fDeribit]!),
      gDeribitIv: gDeribit,
      fMinusGDeribitIv: fgDeribit,
      timeToExpiryMs: tte,
      annualizedSigma5m: sig5,
      tradeSignalSigma5m:
        signal5 === 1 || signal5 === 0 || signal5 === -1 ? signal5 : null,
      tradeSignalSigma10m:
        signal10 === 1 || signal10 === 0 || signal10 === -1 ? signal10 : null,
      tradeSignalDeribitIv:
        signal === 1 || signal === 0 || signal === -1 ? signal : null,
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

interface SelectedSignalFields {
  signal: -1 | 0 | 1 | null;
  f: number | null;
  g: number | null;
  fMinusG: number | null;
}

function pickSignalFields(row: CsvRow, variant: VariantKey): SelectedSignalFields {
  if (variant === 'a') {
    return {
      signal: row.tradeSignalSigma5m,
      f: row.fSigma5m,
      g: row.gSigma5m,
      fMinusG: row.fMinusGSigma5m,
    };
  }
  if (variant === 'b') {
    return {
      signal: row.tradeSignalSigma10m,
      f: row.fSigma10m,
      g: row.gSigma10m,
      fMinusG: row.fMinusGSigma10m,
    };
  }
  return {
    signal: row.tradeSignalDeribitIv,
    f: row.fDeribitIv,
    g: row.gDeribitIv,
    fMinusG: row.fMinusGDeribitIv,
  };
}

function sigmaRegimeOk(
  rows: CsvRow[],
  i: number,
  window: number,
  minRatio: number,
  maxRatio: number,
): boolean {
  const row = rows[i];
  const cur = row?.annualizedSigma5m;
  if (cur === null || cur === undefined || !Number.isFinite(cur) || cur <= 0) return false;
  const lo = Math.max(0, i - window + 1);
  const hist: number[] = [];
  for (let j = lo; j <= i; j++) {
    const s = rows[j]?.annualizedSigma5m;
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
  variant: VariantKey,
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
    const fields = pickSignalFields(r, variant);
    if (fields.g === null || fields.fMinusG === null || fields.f === null) continue;

    const buySignal =
      fields.signal === 1 &&
      r.yesAsk > 0 &&
      Number.isFinite(r.yesAsk);

    const spread = r.yesAsk - r.yesBid;
    const spreadOk =
      r.yesBid > 0 &&
      Number.isFinite(r.yesBid) &&
      Number.isFinite(spread) &&
      spread >= 0 &&
      spread <= args.maxYesSpread;

    // trade_signal_deribit_iv already includes confidence filtering in round report generation.
    const confOk = true;

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
        f: fields.f,
        g: fields.g,
        fMinusG: fields.fMinusG,
      });
      positionYes += qty;
    }

    const sellOk =
      fields.signal === -1 &&
      r.yesBid > 0 &&
      Number.isFinite(r.yesBid);

    const roomShort = args.maxYesShares - positionShort;
    if (sellOk && spreadOk && confOk && tteOk && volOk && roomShort > 0) {
      shortFills.push({
        entryRowIndex: i,
        entryIso: r.isoTime,
        entryYesBid: r.yesBid,
        f: fields.f,
        g: fields.g,
        fMinusG: fields.fMinusG,
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

interface VariantSummary {
  longMarkets: number;
  shortMarkets: number;
  longTotalPnl: number;
  shortTotalPnl: number;
  combinedPnl: number;
  longWinRate: number;
  shortWinRate: number;
  longAdds: number;
  shortAdds: number;
}

interface VariantRunResult {
  config: VariantConfig;
  results: MarketRow[];
  summary: VariantSummary;
}

function summarizeVariant(results: MarketRow[]): VariantSummary {
  const longRows = results.filter((r) => r.buyScaled !== null);
  const shortRows = results.filter((r) => r.shortScaled !== null);
  const longTotalPnl = longRows.reduce((sum, r) => sum + (r.buyScaled?.pnl ?? 0), 0);
  const shortTotalPnl = shortRows.reduce((sum, r) => sum + (r.shortScaled?.pnl ?? 0), 0);
  const longWins = longRows.filter((r) => (r.buyScaled?.pnl ?? 0) > 0).length;
  const shortWins = shortRows.filter((r) => (r.shortScaled?.pnl ?? 0) > 0).length;
  const longAdds = longRows.reduce((sum, r) => sum + (r.buyScaled?.fills.length ?? 0), 0);
  const shortAdds = shortRows.reduce((sum, r) => sum + (r.shortScaled?.fills.length ?? 0), 0);

  return {
    longMarkets: longRows.length,
    shortMarkets: shortRows.length,
    longTotalPnl,
    shortTotalPnl,
    combinedPnl: longTotalPnl + shortTotalPnl,
    longWinRate: longRows.length > 0 ? longWins / longRows.length : 0,
    shortWinRate: shortRows.length > 0 ? shortWins / shortRows.length : 0,
    longAdds,
    shortAdds,
  };
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function appendVariantSection(lines: string[], run: VariantRunResult): void {
  const { config, results, summary } = run;
  lines.push(`## Variant (${config.key}) — ${config.title}`);
  lines.push('');
  lines.push(`- signal column: \`${config.signalColumn}\``);
  lines.push(`- f/g/f-g: \`${config.fColumn}\` / \`${config.gColumn}\` / \`${config.fMinusGColumn}\``);
  lines.push(`- long markets with fills: **${summary.longMarkets}**`);
  lines.push(`- short markets with fills: **${summary.shortMarkets}**`);
  lines.push(`- long total PnL: **${formatMoney(summary.longTotalPnl)}**`);
  lines.push(`- short total PnL: **${formatMoney(summary.shortTotalPnl)}**`);
  lines.push(`- combined PnL: **${formatMoney(summary.combinedPnl)}**`);
  lines.push(`- long win rate: **${formatPct(summary.longWinRate)}**`);
  lines.push(`- short win rate: **${formatPct(summary.shortWinRate)}**`);
  lines.push(`- total long adds: **${summary.longAdds}**`);
  lines.push(`- total short adds: **${summary.shortAdds}**`);
  lines.push('');
  lines.push('| source CSV | YES payoff | long PnL | #L | short PnL | #S | combined PnL |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const m of results) {
    if (m.skipReason !== null) {
      lines.push(`\`${m.source}\` | — | — | — | — | — | skipped (${m.skipReason})`);
      continue;
    }
    const longPnl = m.buyScaled?.pnl ?? 0;
    const shortPnl = m.shortScaled?.pnl ?? 0;
    const combined = longPnl + shortPnl;
    lines.push(
      [
        `\`${m.source}\``,
        String(m.yesPayoff ?? '—'),
        m.buyScaled ? formatMoney(longPnl) : '—',
        m.buyScaled ? String(m.buyScaled.fills.length) : '0',
        m.shortScaled ? formatMoney(shortPnl) : '—',
        m.shortScaled ? String(m.shortScaled.fills.length) : '0',
        formatMoney(combined),
      ].join(' | '),
    );
  }
  lines.push('');
}

function buildCombinedMarkdown(args: CliArgs, runs: VariantRunResult[], outputName: string): string {
  const lines: string[] = [];
  lines.push('# Report backtest compare: variants (a)/(b)/(c)');
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- output: \`takerbot/reports/${outputName}\``);
  lines.push(`- source reports: all \`*.csv\` in reports dir (excluding names starting with \`backtest-\`)`);
  lines.push('');

  lines.push('## Parameters used in this run');
  lines.push('');
  lines.push(`- \`δ\` (delta): **${args.delta}**`);
  lines.push(`- \`γ\` (gamma): **${args.gamma}**`);
  lines.push(`- min confidence: **${args.minConfidence}** (currently informational; signal already pre-filtered in report)`);
  lines.push(`- min time-to-expiry (ms): **${args.minTimeToExpiryMs}** (must be strictly greater than this)`);
  lines.push(`- max YES spread (ask−bid): **${args.maxYesSpread}**`);
  lines.push(`- max cumulative shares per side (long cap / short cap): **${args.maxYesShares}**`);
  lines.push(`- sigma median window: **${args.sigmaMedianWindow}**, ratio band: **[${args.sigmaMinRatio}, ${args.sigmaMaxRatio}]× median**`);
  lines.push(`- reports directory: \`${args.reportsDir}\``);
  lines.push('');

  lines.push('## Variant Comparison');
  lines.push('');
  lines.push('| variant | signal column | long PnL | short PnL | combined PnL | long win rate | short win rate | #L adds | #S adds |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const run of runs) {
    lines.push(
      [
        `(${run.config.key}) ${run.config.title}`,
        `\`${run.config.signalColumn}\``,
        formatMoney(run.summary.longTotalPnl),
        formatMoney(run.summary.shortTotalPnl),
        formatMoney(run.summary.combinedPnl),
        formatPct(run.summary.longWinRate),
        formatPct(run.summary.shortWinRate),
        String(run.summary.longAdds),
        String(run.summary.shortAdds),
      ].join(' | '),
    );
  }
  lines.push('');

  const ranked = [...runs].sort((a, b) => b.summary.combinedPnl - a.summary.combinedPnl);
  lines.push('Ranking by combined PnL:');
  ranked.forEach((run, idx) => {
    lines.push(`${idx + 1}. (${run.config.key}) ${run.config.title}: **${formatMoney(run.summary.combinedPnl)}**`);
  });
  lines.push('');

  lines.push('## Per-Market Compare (combined PnL)');
  lines.push('');
  lines.push('| source CSV | payoff | (a) sigma_5m | (b) sigma_10m | (c) deribit_iv |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  const aMap = new Map(runs.find((r) => r.config.key === 'a')?.results.map((r) => [r.source, r]) ?? []);
  const bMap = new Map(runs.find((r) => r.config.key === 'b')?.results.map((r) => [r.source, r]) ?? []);
  const cMap = new Map(runs.find((r) => r.config.key === 'c')?.results.map((r) => [r.source, r]) ?? []);
  const allSources = new Set<string>([...Array.from(aMap.keys()), ...Array.from(bMap.keys()), ...Array.from(cMap.keys())]);
  for (const source of Array.from(allSources).sort()) {
    const a = aMap.get(source);
    const b = bMap.get(source);
    const c = cMap.get(source);
    const payoff = a?.yesPayoff ?? b?.yesPayoff ?? c?.yesPayoff ?? null;
    const combined = (m: MarketRow | undefined) => (m ? (m.buyScaled?.pnl ?? 0) + (m.shortScaled?.pnl ?? 0) : null);
    const fa = combined(a);
    const fb = combined(b);
    const fc = combined(c);
    lines.push(
      [
        `\`${source}\``,
        payoff === null ? '—' : String(payoff),
        fa === null ? '—' : formatMoney(fa),
        fb === null ? '—' : formatMoney(fb),
        fc === null ? '—' : formatMoney(fc),
      ].join(' | '),
    );
  }
  lines.push('');

  for (const run of runs) {
    appendVariantSection(lines, run);
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const names = await readdir(args.reportsDir);
  const csvNames = names.filter(
    (n) => n.endsWith('.csv') && !n.startsWith('backtest-'),
  );
  csvNames.sort();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parsedByName = new Map<string, CsvRow[]>();
  for (const name of csvNames) {
    const path = resolve(args.reportsDir, name);
    const raw = await readFile(path, 'utf8');
    parsedByName.set(name, parseCsv(raw));
  }

  const runs: VariantRunResult[] = [];
  for (const variantConfig of VARIANT_CONFIGS) {
    const bundle: MarketRow[] = [];
    for (const name of csvNames) {
      const rows = parsedByName.get(name) ?? [];
      const slug = name.replace(/\.csv$/i, '');
      const out = runBacktestOnRows(slug, name, rows, args, variantConfig.key);
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
    runs.push({
      config: variantConfig,
      results: bundle,
      summary: summarizeVariant(bundle),
    });
  }
  const outName = `backtest-fg-compare-${stamp}.md`;
  const outPath = resolve(args.reportsDir, outName);
  const md = buildCombinedMarkdown(args, runs, outName);
  await writeFile(outPath, `${md}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
