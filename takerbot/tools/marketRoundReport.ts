import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import type { ActiveMarketInfo, MarketReportPoint } from '../shared/types.js';
import {
  annualizedVolatilityFromPerSecond,
  computeBaseFairValue,
  perSecondVolatilityFromAnnual,
} from '../shared/fairValueMath.js';
import { getMarketReportRows } from '../shared/state.js';

const REPORTS_DIR = resolve(process.cwd(), 'takerbot', 'reports');

export interface GeneratedMarketReport {
  marketId: string;
  slug: string;
  rowCount: number;
  markdownPath: string;
  csvPath: string;
  skipped: boolean;
}

interface ComputedReportRow extends MarketReportPoint {
  isoTime: string;
  /** Chainlink spot (same as stored `btcPrice` on the report point). */
  chainlinkPrice: number;
  /** Binance mid for CSV / tables (`btc_price` column). */
  binancePrice: number | null;
  yesTokenPrice: number;
  /** sigma * sqrt(60*60*24*365) — annualized EWMA volatility (fractional, e.g. 0.65 ≈ 65%). */
  annualizedSigma: number | null;
  /** Same Black–Scholes binary call as fair_value, but σ = Deribit mark_iv annualized. */
  fairValueDeribitIv: number | null;
  /**
   * Binary fair value with blended σ: annual average of EWMA annualized σ and Deribit mark_iv,
   * converted to per-second for Black–Scholes (same contract as fair_value / fair_value_deribit_iv).
   */
  fairValueBlendedSigma: number | null;
  /** f/g/f−g from self EWMA fair value (a). */
  f: number;
  g: number | null;
  fMinusG: number | null;
  /** f/g/f−g from Deribit IV fair value (b). */
  fDeribitIv: number | null;
  gDeribitIv: number | null;
  fMinusGDeribitIv: number | null;
  /** f/g/f−g from blended σ (mean EWMA + Deribit) fair value (c). */
  fMeanFv: number | null;
  gMeanFv: number | null;
  fMinusGMeanFv: number | null;
}

/** When both are present, annual σ is averaged then converted to per-second; otherwise the sole source. */
function blendedPerSecondVolatility(
  ewmaPerSecond: number | null,
  deribitAnnual: number | null,
): number | null {
  const hasEwma = ewmaPerSecond !== null && ewmaPerSecond > 0;
  const hasDeribit = deribitAnnual !== null && deribitAnnual > 0 && Number.isFinite(deribitAnnual);
  if (hasEwma && hasDeribit) {
    const ewmaAnnual = annualizedVolatilityFromPerSecond(ewmaPerSecond!);
    return perSecondVolatilityFromAnnual((ewmaAnnual + deribitAnnual!) / 2);
  }
  if (hasEwma) return ewmaPerSecond!;
  if (hasDeribit) return perSecondVolatilityFromAnnual(deribitAnnual!);
  return null;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function formatNum(value: number | null | undefined, digits = 6): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toFixed(digits);
}

function formatMaybeNumber(value: number | null, digits = 6): string {
  return value === null ? '' : value.toFixed(digits);
}

function fileExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

/** g(t) = mean(f(t−1)…f(t−10)); clears history when the current f is null (no Deribit / blended FV). */
const G_PRIOR_SAMPLES = 10;

function rollingGFromPriorF(
  pastF: number[],
  f: number | null,
): { g: number | null; fMinusG: number | null } {
  if (f === null) {
    pastF.length = 0;
    return { g: null, fMinusG: null };
  }
  const g =
    pastF.length >= G_PRIOR_SAMPLES
      ? pastF.reduce((sum, v) => sum + v, 0) / G_PRIOR_SAMPLES
      : null;
  const fMinusG = g === null ? null : f - g;
  pastF.push(f);
  if (pastF.length > G_PRIOR_SAMPLES) pastF.shift();
  return { g, fMinusG };
}

function computeRows(
  rows: MarketReportPoint[],
  deribitAnnualVolatility: number | null,
): ComputedReportRow[] {
  const computed: ComputedReportRow[] = [];
  const pastPrimaryF: number[] = [];
  const pastDeribitF: number[] = [];
  const pastMeanFvF: number[] = [];
  const perSecondDeribitVolatility =
    deribitAnnualVolatility !== null ? perSecondVolatilityFromAnnual(deribitAnnualVolatility) : null;

  for (const row of rows) {
    const yesTokenPrice = row.yesAsk;
    const f = row.fairValue - yesTokenPrice;
    const { g, fMinusG } = rollingGFromPriorF(pastPrimaryF, f);

    const annualizedSigma =
      row.sigma !== null && row.sigma > 0 ? annualizedVolatilityFromPerSecond(row.sigma) : null;
    const fairValueDeribitIv =
      perSecondDeribitVolatility !== null &&
      row.strikePrice !== null &&
      row.strikePrice > 0 &&
      row.btcPrice > 0
        ? computeBaseFairValue({
            currentPrice: row.btcPrice,
            strikePrice: row.strikePrice,
            timeToExpiryMs: row.timeToExpiryMs,
            perSecondVolatility: perSecondDeribitVolatility,
          })
        : null;

    const blendedPerSecond = blendedPerSecondVolatility(row.sigma, deribitAnnualVolatility);
    const fairValueBlendedSigma =
      blendedPerSecond !== null &&
      row.strikePrice !== null &&
      row.strikePrice > 0 &&
      row.btcPrice > 0
        ? computeBaseFairValue({
            currentPrice: row.btcPrice,
            strikePrice: row.strikePrice,
            timeToExpiryMs: row.timeToExpiryMs,
            perSecondVolatility: blendedPerSecond,
          })
        : null;

    const fDeribitIv =
      fairValueDeribitIv !== null ? fairValueDeribitIv - yesTokenPrice : null;
    const { g: gDeribitIv, fMinusG: fMinusGDeribitIv } = rollingGFromPriorF(pastDeribitF, fDeribitIv);

    const fMeanFv =
      fairValueBlendedSigma !== null ? fairValueBlendedSigma - yesTokenPrice : null;
    const { g: gMeanFv, fMinusG: fMinusGMeanFv } = rollingGFromPriorF(pastMeanFvF, fMeanFv);

    const binancePrice =
      row.binanceBtcPrice !== undefined && row.binanceBtcPrice !== null ? row.binanceBtcPrice : null;

    computed.push({
      ...row,
      sigma: row.sigma ?? null,
      isoTime: new Date(row.ts).toISOString(),
      chainlinkPrice: row.btcPrice,
      binancePrice,
      yesTokenPrice,
      annualizedSigma,
      fairValueDeribitIv,
      fairValueBlendedSigma,
      f,
      g,
      fMinusG,
      fDeribitIv,
      gDeribitIv,
      fMinusGDeribitIv,
      fMeanFv,
      gMeanFv,
      fMinusGMeanFv,
    });
  }

  return computed;
}

function computeSummary(rows: ComputedReportRow[]) {
  if (rows.length === 0) {
    return {
      avgF: null,
      minF: null,
      maxF: null,
      avgAnnualizedSigma: null,
      minAnnualizedSigma: null,
      maxAnnualizedSigma: null,
      avgFairValueDeribitIv: null,
      minFairValueDeribitIv: null,
      maxFairValueDeribitIv: null,
      avgFairValueBlendedSigma: null,
      minFairValueBlendedSigma: null,
      maxFairValueBlendedSigma: null,
      avgResidual: null,
      minResidual: null,
      maxResidual: null,
      avgFDeribitIv: null,
      minFDeribitIv: null,
      maxFDeribitIv: null,
      avgResidualDeribitIv: null,
      minResidualDeribitIv: null,
      maxResidualDeribitIv: null,
      avgFMeanFv: null,
      minFMeanFv: null,
      maxFMeanFv: null,
      avgResidualMeanFv: null,
      minResidualMeanFv: null,
      maxResidualMeanFv: null,
    };
  }

  const fValues = rows.map((row) => row.f);
  const annualizedSigmaValues = rows
    .map((row) => row.annualizedSigma)
    .filter((value): value is number => value !== null);
  const fairValueDeribitValues = rows
    .map((row) => row.fairValueDeribitIv)
    .filter((value): value is number => value !== null);
  const fairValueBlendedSigmaValues = rows
    .map((row) => row.fairValueBlendedSigma)
    .filter((value): value is number => value !== null);
  const residuals = rows
    .map((row) => row.fMinusG)
    .filter((value): value is number => value !== null);
  const fDeribitIvValues = rows
    .map((row) => row.fDeribitIv)
    .filter((value): value is number => value !== null);
  const residualsDeribitIv = rows
    .map((row) => row.fMinusGDeribitIv)
    .filter((value): value is number => value !== null);
  const fMeanFvValues = rows
    .map((row) => row.fMeanFv)
    .filter((value): value is number => value !== null);
  const residualsMeanFv = rows
    .map((row) => row.fMinusGMeanFv)
    .filter((value): value is number => value !== null);

  const average = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    avgF: average(fValues),
    minF: Math.min(...fValues),
    maxF: Math.max(...fValues),
    avgAnnualizedSigma: average(annualizedSigmaValues),
    minAnnualizedSigma:
      annualizedSigmaValues.length > 0 ? Math.min(...annualizedSigmaValues) : null,
    maxAnnualizedSigma:
      annualizedSigmaValues.length > 0 ? Math.max(...annualizedSigmaValues) : null,
    avgFairValueDeribitIv: average(fairValueDeribitValues),
    minFairValueDeribitIv:
      fairValueDeribitValues.length > 0 ? Math.min(...fairValueDeribitValues) : null,
    maxFairValueDeribitIv:
      fairValueDeribitValues.length > 0 ? Math.max(...fairValueDeribitValues) : null,
    avgFairValueBlendedSigma: average(fairValueBlendedSigmaValues),
    minFairValueBlendedSigma:
      fairValueBlendedSigmaValues.length > 0 ? Math.min(...fairValueBlendedSigmaValues) : null,
    maxFairValueBlendedSigma:
      fairValueBlendedSigmaValues.length > 0 ? Math.max(...fairValueBlendedSigmaValues) : null,
    avgResidual: average(residuals),
    minResidual: residuals.length > 0 ? Math.min(...residuals) : null,
    maxResidual: residuals.length > 0 ? Math.max(...residuals) : null,
    avgFDeribitIv: average(fDeribitIvValues),
    minFDeribitIv: fDeribitIvValues.length > 0 ? Math.min(...fDeribitIvValues) : null,
    maxFDeribitIv: fDeribitIvValues.length > 0 ? Math.max(...fDeribitIvValues) : null,
    avgResidualDeribitIv: average(residualsDeribitIv),
    minResidualDeribitIv:
      residualsDeribitIv.length > 0 ? Math.min(...residualsDeribitIv) : null,
    maxResidualDeribitIv:
      residualsDeribitIv.length > 0 ? Math.max(...residualsDeribitIv) : null,
    avgFMeanFv: average(fMeanFvValues),
    minFMeanFv: fMeanFvValues.length > 0 ? Math.min(...fMeanFvValues) : null,
    maxFMeanFv: fMeanFvValues.length > 0 ? Math.max(...fMeanFvValues) : null,
    avgResidualMeanFv: average(residualsMeanFv),
    minResidualMeanFv: residualsMeanFv.length > 0 ? Math.min(...residualsMeanFv) : null,
    maxResidualMeanFv: residualsMeanFv.length > 0 ? Math.max(...residualsMeanFv) : null,
  };
}

function toCsv(rows: ComputedReportRow[]): string {
  const header = [
    'iso_time',
    'ts',
    'published_at',
    'fair_value',
    'fair_value_blended_sigma',
    'confidence',
    'annualized_sigma',
    'fair_value_deribit_iv',
    'chainlink_price',
    'btc_price',
    'strike_price',
    'yes_bid',
    'yes_ask',
    'no_bid',
    'no_ask',
    'time_to_expiry_ms',
    'time_to_expiry_sec',
    'yes_token_price',
    'f',
    'g',
    'f_minus_g',
    'f_deribit_iv',
    'g_deribit_iv',
    'f_minus_g_deribit_iv',
    'f_mean_fv',
    'g_mean_fv',
    'f_minus_g_mean_fv',
  ];

  const lines = rows.map((row) =>
    [
      row.isoTime,
      String(row.ts),
      String(row.publishedAt),
      formatNum(row.fairValue),
      formatMaybeNumber(row.fairValueBlendedSigma),
      formatNum(row.confidence),
      formatMaybeNumber(row.annualizedSigma),
      formatMaybeNumber(row.fairValueDeribitIv),
      formatNum(row.chainlinkPrice, 2),
      row.binancePrice !== null ? formatNum(row.binancePrice, 2) : '',
      formatMaybeNumber(row.strikePrice, 2),
      formatNum(row.yesBid),
      formatNum(row.yesAsk),
      formatNum(row.noBid),
      formatNum(row.noAsk),
      String(row.timeToExpiryMs),
      String(Math.round(row.timeToExpiryMs / 1000)),
      formatNum(row.yesTokenPrice),
      formatNum(row.f),
      formatMaybeNumber(row.g),
      formatMaybeNumber(row.fMinusG),
      formatMaybeNumber(row.fDeribitIv),
      formatMaybeNumber(row.gDeribitIv),
      formatMaybeNumber(row.fMinusGDeribitIv),
      formatMaybeNumber(row.fMeanFv),
      formatMaybeNumber(row.gMeanFv),
      formatMaybeNumber(row.fMinusGMeanFv),
    ].join(','),
  );

  return [header.join(','), ...lines].join('\n');
}

function toMarkdown(market: ActiveMarketInfo, rows: ComputedReportRow[], csvPath: string): string {
  const summary = computeSummary(rows);
  const firstRow = rows[0] ?? null;
  const lastRow = rows[rows.length - 1] ?? null;
  const relativeCsvPath = csvPath.replace(`${process.cwd()}/`, '');
  const deribitInstrumentName = typeof market.deribitInstrumentName === 'string' ? market.deribitInstrumentName : null;
  const deribitMarkIvAnnual =
    typeof market.deribitMarkIvAnnual === 'number' && Number.isFinite(market.deribitMarkIvAnnual)
      ? market.deribitMarkIvAnnual
      : null;

  const lines: string[] = [];
  lines.push(`# Market Round Report: ${market.slug}`);
  lines.push('');
  lines.push(`- marketId: \`${market.conditionId}\``);
  lines.push(`- question: ${market.question}`);
  lines.push(`- slug: \`${market.slug}\``);
  lines.push(`- expiry: ${market.endDate}`);
  lines.push(`- strikePrice: ${market.strikePrice === null ? 'N/A' : `$${market.strikePrice.toFixed(2)}`}`);
  lines.push(
    `- deribitInstrument: ${deribitInstrumentName ? `\`${deribitInstrumentName}\`` : 'N/A'}`
  );
  lines.push(
    `- deribitMarkIv: ${
      deribitMarkIvAnnual === null ? 'N/A' : `${(deribitMarkIvAnnual * 100).toFixed(2)}%`
    }`
  );
  lines.push(`- rows: ${rows.length}`);
  lines.push(`- csv: \`${relativeCsvPath}\``);
  lines.push('');
  lines.push('## Formula Notes');
  lines.push('');
  lines.push(
    '- `chainlink_price(t)` is the Chainlink BTC/USD spot used as **S** in the EWMA-σ fair value model.',
  );
  lines.push(
    '- `btc_price(t)` is the Binance book-ticker **mid** at the same sample time (diagnostics / settlement proxy in downstream tools).',
  );
  lines.push('- `yes token price(t)` uses `yes ask`.');
  lines.push(
    '- `annualized_sigma(t) = sigma(t) * sqrt(60*60*24*365)` — EWMA σ from stored samples, annualized fraction (e.g. 0.40 = 40%).',
  );
  lines.push(
    '- `fair_value_blended_sigma` is the binary-call fair value using blended volatility: annual σ = average(`annualized_sigma(t)`, Deribit `mark_iv` annual), converted to per-second for Black–Scholes; if only one source exists, that source is used.',
  );
  lines.push(
    '- `fair_value_deribit_iv` is the binary-call fair value using only Deribit `mark_iv` annualized volatility from market discovery.',
  );
  lines.push('- `f(t) = fair value(t) - yes token price(t)` — self EWMA σ fair value (a).');
  lines.push(
    '- `g(t) = (1/10) * sum(f(t-k), k=1..10)` — average of the **previous** 10 `f` samples; blank until 10 prior rows exist.',
  );
  lines.push(
    '- **(b)** `f_deribit_iv` / `g_deribit_iv` / `f_minus_g_deribit_iv` (CSV): same lag-10 `g` rule but `f` uses `fair_value_deribit_iv − yes_ask`. History clears after any row where Deribit FV is missing.',
  );
  lines.push(
    '- **(c)** `f_mean_fv` / `g_mean_fv` / `f_minus_g_mean_fv` (CSV): same lag-10 `g` using `fair_value_blended_sigma − yes_ask`. History clears when blended FV is missing.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- first sample: ${firstRow ? firstRow.isoTime : 'N/A'}`);
  lines.push(`- last sample: ${lastRow ? lastRow.isoTime : 'N/A'}`);
  lines.push(`- avg f(t): ${formatMaybeNumber(summary.avgF) || 'N/A'}`);
  lines.push(`- min f(t): ${formatMaybeNumber(summary.minF) || 'N/A'}`);
  lines.push(`- max f(t): ${formatMaybeNumber(summary.maxF) || 'N/A'}`);
  lines.push(`- avg annualized_sigma(t): ${formatMaybeNumber(summary.avgAnnualizedSigma) || 'N/A'}`);
  lines.push(`- min annualized_sigma(t): ${formatMaybeNumber(summary.minAnnualizedSigma) || 'N/A'}`);
  lines.push(`- max annualized_sigma(t): ${formatMaybeNumber(summary.maxAnnualizedSigma) || 'N/A'}`);
  lines.push(`- avg fair_value_deribit_iv: ${formatMaybeNumber(summary.avgFairValueDeribitIv) || 'N/A'}`);
  lines.push(`- min fair_value_deribit_iv: ${formatMaybeNumber(summary.minFairValueDeribitIv) || 'N/A'}`);
  lines.push(`- max fair_value_deribit_iv: ${formatMaybeNumber(summary.maxFairValueDeribitIv) || 'N/A'}`);
  lines.push(
    `- avg fair_value_blended_sigma: ${formatMaybeNumber(summary.avgFairValueBlendedSigma) || 'N/A'}`,
  );
  lines.push(
    `- min fair_value_blended_sigma: ${formatMaybeNumber(summary.minFairValueBlendedSigma) || 'N/A'}`,
  );
  lines.push(
    `- max fair_value_blended_sigma: ${formatMaybeNumber(summary.maxFairValueBlendedSigma) || 'N/A'}`,
  );
  lines.push(`- avg f(t)-g(t): ${formatMaybeNumber(summary.avgResidual) || 'N/A'}`);
  lines.push(`- min f(t)-g(t): ${formatMaybeNumber(summary.minResidual) || 'N/A'}`);
  lines.push(`- max f(t)-g(t): ${formatMaybeNumber(summary.maxResidual) || 'N/A'}`);
  lines.push(`- avg f_deribit_iv: ${formatMaybeNumber(summary.avgFDeribitIv) || 'N/A'}`);
  lines.push(`- min f_deribit_iv: ${formatMaybeNumber(summary.minFDeribitIv) || 'N/A'}`);
  lines.push(`- max f_deribit_iv: ${formatMaybeNumber(summary.maxFDeribitIv) || 'N/A'}`);
  lines.push(
    `- avg f_deribit_iv - g: ${formatMaybeNumber(summary.avgResidualDeribitIv) || 'N/A'}`,
  );
  lines.push(
    `- min f_deribit_iv - g: ${formatMaybeNumber(summary.minResidualDeribitIv) || 'N/A'}`,
  );
  lines.push(
    `- max f_deribit_iv - g: ${formatMaybeNumber(summary.maxResidualDeribitIv) || 'N/A'}`,
  );
  lines.push(`- avg f_mean_fv: ${formatMaybeNumber(summary.avgFMeanFv) || 'N/A'}`);
  lines.push(`- min f_mean_fv: ${formatMaybeNumber(summary.minFMeanFv) || 'N/A'}`);
  lines.push(`- max f_mean_fv: ${formatMaybeNumber(summary.maxFMeanFv) || 'N/A'}`);
  lines.push(`- avg f_mean_fv - g: ${formatMaybeNumber(summary.avgResidualMeanFv) || 'N/A'}`);
  lines.push(`- min f_mean_fv - g: ${formatMaybeNumber(summary.minResidualMeanFv) || 'N/A'}`);
  lines.push(`- max f_mean_fv - g: ${formatMaybeNumber(summary.maxResidualMeanFv) || 'N/A'}`);
  lines.push('');
  lines.push('## Rows');
  lines.push('');
  lines.push(
    '| time | fair value | fair value (σ EWMA+Deribit) | annualized σ | fv deribit iv | chainlink | binance | yes bid | yes ask | no bid | no ask | tte ms | f (a) | g (a) | f-g (a) | f (b) | g (b) | f-g (b) | f (c) | g (c) | f-g (c) |',
  );
  lines.push(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const row of rows) {
    lines.push(
      `| ${row.isoTime} | ${formatNum(row.fairValue)} | ${formatMaybeNumber(row.fairValueBlendedSigma)} | ` +
        `${formatMaybeNumber(row.annualizedSigma)} | ${formatMaybeNumber(row.fairValueDeribitIv)} | ` +
        `${formatNum(row.chainlinkPrice, 2)} | ${formatMaybeNumber(row.binancePrice, 2) || 'N/A'} | ${formatNum(row.yesBid)} | ${formatNum(row.yesAsk)} | ` +
        `${formatNum(row.noBid)} | ${formatNum(row.noAsk)} | ${row.timeToExpiryMs} | ${formatNum(row.f)} | ` +
        `${formatMaybeNumber(row.g)} | ${formatMaybeNumber(row.fMinusG)} | ` +
        `${formatMaybeNumber(row.fDeribitIv)} | ${formatMaybeNumber(row.gDeribitIv)} | ` +
        `${formatMaybeNumber(row.fMinusGDeribitIv)} | ${formatMaybeNumber(row.fMeanFv)} | ` +
        `${formatMaybeNumber(row.gMeanFv)} | ${formatMaybeNumber(row.fMinusGMeanFv)} |`,
    );
  }

  return lines.join('\n');
}

export async function generateMarketRoundReport(
  market: ActiveMarketInfo,
  options: { force?: boolean } = {},
): Promise<GeneratedMarketReport> {
  await mkdir(REPORTS_DIR, { recursive: true });

  const fileBase = sanitizeFilePart(market.slug || market.conditionId);
  const markdownPath = resolve(REPORTS_DIR, `${fileBase}.md`);
  const csvPath = resolve(REPORTS_DIR, `${fileBase}.csv`);

  if (!options.force) {
    const [hasMarkdown, hasCsv] = await Promise.all([fileExists(markdownPath), fileExists(csvPath)]);
    if (hasMarkdown && hasCsv) {
      return {
        marketId: market.conditionId,
        slug: market.slug,
        rowCount: 0,
        markdownPath,
        csvPath,
        skipped: true,
      };
    }
  }

  const deribitMarkIvAnnual =
    typeof market.deribitMarkIvAnnual === 'number' && Number.isFinite(market.deribitMarkIvAnnual)
      ? market.deribitMarkIvAnnual
      : null;
  const rows = computeRows(await getMarketReportRows(market.conditionId), deribitMarkIvAnnual);
  const markdown = toMarkdown(market, rows, csvPath);
  const csv = toCsv(rows);

  await Promise.all([
    writeFile(markdownPath, `${markdown}\n`, 'utf8'),
    writeFile(csvPath, `${csv}\n`, 'utf8'),
  ]);

  return {
    marketId: market.conditionId,
    slug: market.slug,
    rowCount: rows.length,
    markdownPath,
    csvPath,
    skipped: false,
  };
}
