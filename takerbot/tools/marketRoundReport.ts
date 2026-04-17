import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import type { ActiveMarketInfo, MarketReportPoint } from '../shared/types.js';
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
  chainlinkPrice: number;
  yesTokenPrice: number;
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

    computed.push({
      ...row,
      isoTime: new Date(row.ts).toISOString(),
      chainlinkPrice: row.btcPrice,
      yesTokenPrice,
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
      avgResidual: null,
      minResidual: null,
      maxResidual: null,
    };
  }

  const fValues = rows.map((row) => row.f);
  const residuals = rows
    .map((row) => row.fMinusG)
    .filter((value): value is number => value !== null);

  const average = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    avgF: average(fValues),
    minF: Math.min(...fValues),
    maxF: Math.max(...fValues),
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
  lines.push(`- avg f(t)-g(t): ${formatMaybeNumber(summary.avgResidual) || 'N/A'}`);
  lines.push(`- min f(t)-g(t): ${formatMaybeNumber(summary.minResidual) || 'N/A'}`);
  lines.push(`- max f(t)-g(t): ${formatMaybeNumber(summary.maxResidual) || 'N/A'}`);
  lines.push('');
  lines.push('## Rows');
  lines.push('');
  lines.push('| time | fair value | chainlink price | yes bid | yes ask | no bid | no ask | tte ms | f(t) | g(t) | f(t)-g(t) |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const row of rows) {
    lines.push(
      `| ${row.isoTime} | ${formatNum(row.fairValue)} | ${formatNum(row.chainlinkPrice, 2)} | ` +
        `${formatNum(row.yesBid)} | ${formatNum(row.yesAsk)} | ${formatNum(row.noBid)} | ` +
        `${formatNum(row.noAsk)} | ${row.timeToExpiryMs} | ${formatNum(row.f)} | ` +
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
