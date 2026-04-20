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

/** Fair value using fixed 40% annualized BTC volatility (comparison baseline). */
const FIXED_ANNUAL_VOLATILITY = 0.4;
const FIXED_ANNUAL_VOLATILITY_LABEL = `${(FIXED_ANNUAL_VOLATILITY * 100).toFixed(0)}%`;
const PER_SECOND_FIXED_ANNUAL_VOLATILITY = perSecondVolatilityFromAnnual(FIXED_ANNUAL_VOLATILITY);

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
  chainlinkPrice: number;
  yesTokenPrice: number;
  /** sigma * sqrt(60*60*24*365) — annualized EWMA volatility (fractional, e.g. 0.65 ≈ 65%). */
  annualizedSigma: number | null;
  /** Same Black–Scholes binary call as fair_value, but σ = 40% annualized. */
  fairValue40pctAnnual: number | null;
  f: number;
  g: number | null;
  fMinusG: number | null;
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

function computeRows(rows: MarketReportPoint[]): ComputedReportRow[] {
  const computed: ComputedReportRow[] = [];
  const fWindow: number[] = [];

  for (const row of rows) {
    const yesTokenPrice = row.yesAsk;
    const f = row.fairValue - yesTokenPrice;
    fWindow.push(f);
    if (fWindow.length > 5) fWindow.shift();

    const g = fWindow.length === 5 ? fWindow.reduce((sum, value) => sum + value, 0) / 5 : null;
    const fMinusG = g === null ? null : f - g;

    const annualizedSigma =
      row.sigma !== null && row.sigma > 0 ? annualizedVolatilityFromPerSecond(row.sigma) : null;
    const fairValue40pctAnnual =
      row.strikePrice !== null && row.strikePrice > 0 && row.btcPrice > 0
        ? computeBaseFairValue({
            currentPrice: row.btcPrice,
            strikePrice: row.strikePrice,
            timeToExpiryMs: row.timeToExpiryMs,
            perSecondVolatility: PER_SECOND_FIXED_ANNUAL_VOLATILITY,
          })
        : null;

    computed.push({
      ...row,
      sigma: row.sigma ?? null,
      isoTime: new Date(row.ts).toISOString(),
      chainlinkPrice: row.btcPrice,
      yesTokenPrice,
      annualizedSigma,
      fairValue40pctAnnual,
      f,
      g,
      fMinusG,
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
      avgSigma: null,
      minSigma: null,
      maxSigma: null,
      avgAnnualizedSigma: null,
      minAnnualizedSigma: null,
      maxAnnualizedSigma: null,
      avgFairValue40pctAnnual: null,
      minFairValue40pctAnnual: null,
      maxFairValue40pctAnnual: null,
      avgResidual: null,
      minResidual: null,
      maxResidual: null,
    };
  }

  const fValues = rows.map((row) => row.f);
  const sigmaValues = rows
    .map((row) => row.sigma)
    .filter((value): value is number => value !== null);
  const annualizedSigmaValues = rows
    .map((row) => row.annualizedSigma)
    .filter((value): value is number => value !== null);
  const fairValue40Values = rows
    .map((row) => row.fairValue40pctAnnual)
    .filter((value): value is number => value !== null);
  const residuals = rows
    .map((row) => row.fMinusG)
    .filter((value): value is number => value !== null);

  const average = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    avgF: average(fValues),
    minF: Math.min(...fValues),
    maxF: Math.max(...fValues),
    avgSigma: average(sigmaValues),
    minSigma: sigmaValues.length > 0 ? Math.min(...sigmaValues) : null,
    maxSigma: sigmaValues.length > 0 ? Math.max(...sigmaValues) : null,
    avgAnnualizedSigma: average(annualizedSigmaValues),
    minAnnualizedSigma:
      annualizedSigmaValues.length > 0 ? Math.min(...annualizedSigmaValues) : null,
    maxAnnualizedSigma:
      annualizedSigmaValues.length > 0 ? Math.max(...annualizedSigmaValues) : null,
    avgFairValue40pctAnnual: average(fairValue40Values),
    minFairValue40pctAnnual:
      fairValue40Values.length > 0 ? Math.min(...fairValue40Values) : null,
    maxFairValue40pctAnnual:
      fairValue40Values.length > 0 ? Math.max(...fairValue40Values) : null,
    avgResidual: average(residuals),
    minResidual: residuals.length > 0 ? Math.min(...residuals) : null,
    maxResidual: residuals.length > 0 ? Math.max(...residuals) : null,
  };
}

function toCsv(rows: ComputedReportRow[]): string {
  const header = [
    'iso_time',
    'ts',
    'published_at',
    'fair_value',
    'confidence',
    'sigma',
    'annualized_sigma',
    'fair_value_40pct_annual',
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
  ];

  const lines = rows.map((row) =>
    [
      row.isoTime,
      String(row.ts),
      String(row.publishedAt),
      formatNum(row.fairValue),
      formatNum(row.confidence),
      formatMaybeNumber(row.sigma),
      formatMaybeNumber(row.annualizedSigma),
      formatMaybeNumber(row.fairValue40pctAnnual),
      formatNum(row.chainlinkPrice, 2),
      formatNum(row.btcPrice, 2),
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
    ].join(','),
  );

  return [header.join(','), ...lines].join('\n');
}

function toMarkdown(market: ActiveMarketInfo, rows: ComputedReportRow[], csvPath: string): string {
  const summary = computeSummary(rows);
  const firstRow = rows[0] ?? null;
  const lastRow = rows[rows.length - 1] ?? null;
  const relativeCsvPath = csvPath.replace(`${process.cwd()}/`, '');

  const lines: string[] = [];
  lines.push(`# Market Round Report: ${market.slug}`);
  lines.push('');
  lines.push(`- marketId: \`${market.conditionId}\``);
  lines.push(`- question: ${market.question}`);
  lines.push(`- slug: \`${market.slug}\``);
  lines.push(`- expiry: ${market.endDate}`);
  lines.push(`- strikePrice: ${market.strikePrice === null ? 'N/A' : `$${market.strikePrice.toFixed(2)}`}`);
  lines.push(`- rows: ${rows.length}`);
  lines.push(`- csv: \`${relativeCsvPath}\``);
  lines.push('');
  lines.push('## Formula Notes');
  lines.push('');
  lines.push('- `chainlink price(t)` is the Chainlink BTC/USD spot used by the fair value model.');
  lines.push('- `yes token price(t)` uses `yes ask`.');
  lines.push('- `sigma(t)` is the per-second EWMA volatility used by the fair value model.');
  lines.push(
    '- `annualized_sigma(t) = sigma(t) * sqrt(60*60*24*365)` — same EWMA σ expressed as annualized fraction (e.g. 0.40 = 40%).',
  );
  lines.push(
    `- \`fair_value_40pct_annual\` is the binary-call fair value using a fixed **${FIXED_ANNUAL_VOLATILITY_LABEL} annualized** BTC volatility (for comparison when EWMA σ drifts).`,
  );
  lines.push('- `f(t) = fair value(t) - yes token price(t)`.');
  lines.push('- `g(t)` is the 5-point moving average of `f(t)` and is blank until 5 samples exist.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- first sample: ${firstRow ? firstRow.isoTime : 'N/A'}`);
  lines.push(`- last sample: ${lastRow ? lastRow.isoTime : 'N/A'}`);
  lines.push(`- avg f(t): ${formatMaybeNumber(summary.avgF) || 'N/A'}`);
  lines.push(`- min f(t): ${formatMaybeNumber(summary.minF) || 'N/A'}`);
  lines.push(`- max f(t): ${formatMaybeNumber(summary.maxF) || 'N/A'}`);
  lines.push(`- avg sigma(t): ${formatMaybeNumber(summary.avgSigma) || 'N/A'}`);
  lines.push(`- min sigma(t): ${formatMaybeNumber(summary.minSigma) || 'N/A'}`);
  lines.push(`- max sigma(t): ${formatMaybeNumber(summary.maxSigma) || 'N/A'}`);
  lines.push(`- avg annualized_sigma(t): ${formatMaybeNumber(summary.avgAnnualizedSigma) || 'N/A'}`);
  lines.push(`- min annualized_sigma(t): ${formatMaybeNumber(summary.minAnnualizedSigma) || 'N/A'}`);
  lines.push(`- max annualized_sigma(t): ${formatMaybeNumber(summary.maxAnnualizedSigma) || 'N/A'}`);
  lines.push(
    `- avg fair_value_40pct_annual: ${formatMaybeNumber(summary.avgFairValue40pctAnnual) || 'N/A'}`,
  );
  lines.push(
    `- min fair_value_40pct_annual: ${formatMaybeNumber(summary.minFairValue40pctAnnual) || 'N/A'}`,
  );
  lines.push(
    `- max fair_value_40pct_annual: ${formatMaybeNumber(summary.maxFairValue40pctAnnual) || 'N/A'}`,
  );
  lines.push(`- avg f(t)-g(t): ${formatMaybeNumber(summary.avgResidual) || 'N/A'}`);
  lines.push(`- min f(t)-g(t): ${formatMaybeNumber(summary.minResidual) || 'N/A'}`);
  lines.push(`- max f(t)-g(t): ${formatMaybeNumber(summary.maxResidual) || 'N/A'}`);
  lines.push('');
  lines.push('## Rows');
  lines.push('');
  lines.push(
    '| time | fair value | sigma | annualized σ | fv 40% ann | chainlink | yes bid | yes ask | no bid | no ask | tte ms | f(t) | g(t) | f-g |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const row of rows) {
    lines.push(
      `| ${row.isoTime} | ${formatNum(row.fairValue)} | ${formatMaybeNumber(row.sigma)} | ` +
        `${formatMaybeNumber(row.annualizedSigma)} | ${formatMaybeNumber(row.fairValue40pctAnnual)} | ` +
        `${formatNum(row.chainlinkPrice, 2)} | ${formatNum(row.yesBid)} | ${formatNum(row.yesAsk)} | ` +
        `${formatNum(row.noBid)} | ${formatNum(row.noAsk)} | ${row.timeToExpiryMs} | ${formatNum(row.f)} | ` +
        `${formatMaybeNumber(row.g)} | ${formatMaybeNumber(row.fMinusG)} |`,
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

  const rows = computeRows(await getMarketReportRows(market.conditionId));
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
