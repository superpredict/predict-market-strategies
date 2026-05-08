import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import {
  MIN_CONFIDENCE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
  TAKER_FEE_RATE,
} from '../config/constants.js';
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
  yesExecutionSide: 'buy' | 'sell';
  yesTokenPriceFeeAdj: number;
  /** sigma * sqrt(60*60*24*365) — annualized EWMA volatility (fractional, e.g. 0.65 ≈ 65%). */
  annualizedSigma: number | null;
  /** Annualized volatility from 1-minute sampled EWMA sigma. */
  annualizedSigma1m: number | null;
  /** Annualized volatility from 5-minute sampled EWMA sigma. */
  annualizedSigma5m: number | null;
  /** Annualized volatility from 10-minute sampled EWMA sigma. */
  annualizedSigma10m: number | null;
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
  fSigma5m: number | null;
  gSigma5m: number | null;
  fMinusGSigma5m: number | null;
  /** f/g/f−g from Deribit IV fair value (b). */
  fDeribitIv: number | null;
  gDeribitIv: number | null;
  fMinusGDeribitIv: number | null;
  tradeSignalSigma5m: -1 | 0 | 1;
  tradeSignalSigma10m: -1 | 0 | 1;
  tradeSignalDeribitIv: -1 | 0 | 1;
  fSigma10m: number | null;
  gSigma10m: number | null;
  fMinusGSigma10m: number | null;
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

function formatMaybeNumber(value: number | null | undefined, digits = 6): string {
  return value === null || value === undefined ? '' : value.toFixed(digits);
}

function fileExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

/** g(t) = mean(f(t−1)…f(t−10)); clears history when the current f is null (no Deribit / blended FV). */
const G_PRIOR_SAMPLES = 10;
const SIGNAL_DELTA = 0.06;
const SIGNAL_GAMMA = 0.04;
const SIGNAL_MAX_YES_SPREAD = 0.08;
const SIGNAL_SIGMA_MEDIAN_WINDOW = 31;
const SIGNAL_SIGMA_MIN_RATIO = 0.35;
const SIGNAL_SIGMA_MAX_RATIO = 3.5;

type ExecutionSide = 'buy' | 'sell';

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

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

function sigmaRegimeOk(
  rows: ComputedReportRow[],
  index: number,
  sigmaKey: 'annualizedSigma5m' | 'annualizedSigma10m',
): boolean {
  const current = rows[index]?.[sigmaKey];
  if (current === null || current === undefined || !Number.isFinite(current) || current <= 0) {
    return false;
  }
  const from = Math.max(0, index - SIGNAL_SIGMA_MEDIAN_WINDOW + 1);
  const history: number[] = [];
  for (let i = from; i <= index; i++) {
    const value = rows[i]?.[sigmaKey];
    if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) history.push(value);
  }
  const minSamples = Math.min(5, Math.max(3, Math.floor(SIGNAL_SIGMA_MEDIAN_WINDOW / 6)));
  if (history.length < minSamples) return false;
  const med = median(history);
  if (!Number.isFinite(med) || med <= 0) return false;
  return current >= med * SIGNAL_SIGMA_MIN_RATIO && current <= med * SIGNAL_SIGMA_MAX_RATIO;
}

function deribitRegimeOk(
  rows: ComputedReportRow[],
  index: number,
  deribitAnnualVolatility: number | null,
): boolean {
  if (
    deribitAnnualVolatility === null ||
    !Number.isFinite(deribitAnnualVolatility) ||
    deribitAnnualVolatility <= 0
  ) {
    return false;
  }
  const row = rows[index];
  if (
    !row ||
    row.fDeribitIv === null ||
    row.gDeribitIv === null ||
    row.fMinusGDeribitIv === null ||
    !Number.isFinite(row.fDeribitIv) ||
    !Number.isFinite(row.gDeribitIv) ||
    !Number.isFinite(row.fMinusGDeribitIv)
  ) {
    return false;
  }
  // Deribit-only regime: use rolling |f_deribit_iv| stability band.
  const from = Math.max(0, index - SIGNAL_SIGMA_MEDIAN_WINDOW + 1);
  const absFHist: number[] = [];
  for (let i = from; i <= index; i++) {
    const f = rows[i]?.fDeribitIv;
    if (f !== null && f !== undefined && Number.isFinite(f)) absFHist.push(Math.abs(f));
  }
  const minSamples = Math.min(5, Math.max(3, Math.floor(SIGNAL_SIGMA_MEDIAN_WINDOW / 6)));
  if (absFHist.length < minSamples) return false;
  const medAbsF = median(absFHist);
  if (!Number.isFinite(medAbsF) || medAbsF <= 0) return false;
  const curAbsF = Math.abs(row.fDeribitIv);
  return curAbsF >= medAbsF * SIGNAL_SIGMA_MIN_RATIO && curAbsF <= medAbsF * SIGNAL_SIGMA_MAX_RATIO;
}

function computeTradeSignal(
  row: ComputedReportRow,
  f: number | null,
  fMinusG: number | null,
  sigmaRegimePass: boolean,
): -1 | 0 | 1 {
  if (f === null || fMinusG === null) return 0;
  const spread = row.yesAsk - row.yesBid;
  const spreadOk =
    row.yesBid > 0 &&
    Number.isFinite(row.yesBid) &&
    Number.isFinite(spread) &&
    spread >= 0 &&
    spread <= SIGNAL_MAX_YES_SPREAD;
  const confOk = Number.isFinite(row.confidence) && row.confidence >= MIN_CONFIDENCE;
  const tteOk = Number.isFinite(row.timeToExpiryMs) && row.timeToExpiryMs > STOP_TRADING_BEFORE_EXPIRY_MS;
  if (!spreadOk || !confOk || !tteOk || !sigmaRegimePass) return 0;
  if (f >= SIGNAL_DELTA && fMinusG >= SIGNAL_GAMMA) return 1;
  if (f <= -SIGNAL_DELTA && fMinusG <= -SIGNAL_GAMMA) return -1;
  return 0;
}

function directionalYesExecutionPrice(
  fairValue: number | null | undefined,
  yesBid: number,
  yesAsk: number,
): number {
  if (fairValue === null || fairValue === undefined || !Number.isFinite(fairValue)) return yesAsk;
  // Use ask for buy-side valuation and bid for sell-side valuation, based on fair value vs mid.
  const mid = (yesBid + yesAsk) / 2;
  return fairValue >= mid ? yesAsk : yesBid;
}

function directionalExecutionSide(
  fairValue: number | null | undefined,
  yesBid: number,
  yesAsk: number,
): ExecutionSide {
  if (fairValue === null || fairValue === undefined || !Number.isFinite(fairValue)) return 'buy';
  const mid = (yesBid + yesAsk) / 2;
  return fairValue >= mid ? 'buy' : 'sell';
}

function feeAdjustedYesExecutionPrice(rawPrice: number, side: ExecutionSide): number {
  return side === 'buy'
    ? rawPrice * (1 + TAKER_FEE_RATE)
    : rawPrice * (1 - TAKER_FEE_RATE);
}

function computeRows(
  rows: MarketReportPoint[],
  deribitAnnualVolatility: number | null,
): ComputedReportRow[] {
  const computed: ComputedReportRow[] = [];
  const pastPrimaryF: number[] = [];
  const pastSigma5mF: number[] = [];
  const pastDeribitF: number[] = [];
  const pastMeanFvF: number[] = [];
  const pastSigma10mF: number[] = [];
  const perSecondDeribitVolatility =
    deribitAnnualVolatility !== null ? perSecondVolatilityFromAnnual(deribitAnnualVolatility) : null;

  for (const row of rows) {
    const yesExecutionSide = directionalExecutionSide(row.fairValue, row.yesBid, row.yesAsk);
    const yesTokenPrice = directionalYesExecutionPrice(row.fairValue, row.yesBid, row.yesAsk);
    const yesTokenPriceFeeAdj = feeAdjustedYesExecutionPrice(yesTokenPrice, yesExecutionSide);
    const f = row.fairValue - yesTokenPriceFeeAdj;
    const { g, fMinusG } = rollingGFromPriorF(pastPrimaryF, f);
    const yesExecutionSideSigma5m = directionalExecutionSide(
      row.fairValueSigma5m,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceSigma5m = directionalYesExecutionPrice(
      row.fairValueSigma5m,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceSigma5mFeeAdj = feeAdjustedYesExecutionPrice(
      yesTokenPriceSigma5m,
      yesExecutionSideSigma5m,
    );
    const fSigma5m =
      row.fairValueSigma5m !== null && row.fairValueSigma5m !== undefined
        ? row.fairValueSigma5m - yesTokenPriceSigma5mFeeAdj
        : null;
    const { g: gSigma5m, fMinusG: fMinusGSigma5m } = rollingGFromPriorF(pastSigma5mF, fSigma5m);

    const annualizedSigma =
      row.sigma !== null && row.sigma > 0 ? annualizedVolatilityFromPerSecond(row.sigma) : null;
    const annualizedSigma1m =
      row.sigma1m !== null && row.sigma1m !== undefined && row.sigma1m > 0
        ? annualizedVolatilityFromPerSecond(row.sigma1m)
        : null;
    const annualizedSigma5m =
      row.sigma5m !== null && row.sigma5m > 0 ? annualizedVolatilityFromPerSecond(row.sigma5m) : null;
    const annualizedSigma10m =
      row.sigma10m !== null && row.sigma10m > 0 ? annualizedVolatilityFromPerSecond(row.sigma10m) : null;
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

    const yesExecutionSideDeribitIv = directionalExecutionSide(
      fairValueDeribitIv,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceDeribitIv = directionalYesExecutionPrice(
      fairValueDeribitIv,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceDeribitIvFeeAdj = feeAdjustedYesExecutionPrice(
      yesTokenPriceDeribitIv,
      yesExecutionSideDeribitIv,
    );
    const fDeribitIv =
      fairValueDeribitIv !== null ? fairValueDeribitIv - yesTokenPriceDeribitIvFeeAdj : null;
    const { g: gDeribitIv, fMinusG: fMinusGDeribitIv } = rollingGFromPriorF(pastDeribitF, fDeribitIv);

    const yesExecutionSideMeanFv = directionalExecutionSide(
      fairValueBlendedSigma,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceMeanFv = directionalYesExecutionPrice(
      fairValueBlendedSigma,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceMeanFvFeeAdj = feeAdjustedYesExecutionPrice(
      yesTokenPriceMeanFv,
      yesExecutionSideMeanFv,
    );
    const fMeanFv =
      fairValueBlendedSigma !== null ? fairValueBlendedSigma - yesTokenPriceMeanFvFeeAdj : null;
    const { g: gMeanFv, fMinusG: fMinusGMeanFv } = rollingGFromPriorF(pastMeanFvF, fMeanFv);
    const yesExecutionSideSigma10m = directionalExecutionSide(
      row.fairValueSigma10m,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceSigma10m = directionalYesExecutionPrice(
      row.fairValueSigma10m,
      row.yesBid,
      row.yesAsk,
    );
    const yesTokenPriceSigma10mFeeAdj = feeAdjustedYesExecutionPrice(
      yesTokenPriceSigma10m,
      yesExecutionSideSigma10m,
    );
    const fSigma10m =
      row.fairValueSigma10m !== null && row.fairValueSigma10m !== undefined
        ? row.fairValueSigma10m - yesTokenPriceSigma10mFeeAdj
        : null;
    const { g: gSigma10m, fMinusG: fMinusGSigma10m } = rollingGFromPriorF(pastSigma10mF, fSigma10m);

    const binancePrice =
      row.binanceBtcPrice !== undefined && row.binanceBtcPrice !== null ? row.binanceBtcPrice : null;

    computed.push({
      ...row,
      sigma: row.sigma ?? null,
      isoTime: new Date(row.ts).toISOString(),
      chainlinkPrice: row.btcPrice,
      binancePrice,
      yesTokenPrice,
      yesExecutionSide,
      yesTokenPriceFeeAdj,
      annualizedSigma,
      annualizedSigma1m,
      annualizedSigma5m,
      annualizedSigma10m,
      fairValueDeribitIv,
      fairValueBlendedSigma,
      f,
      g,
      fMinusG,
      fSigma5m,
      gSigma5m,
      fMinusGSigma5m,
      fDeribitIv,
      gDeribitIv,
      fMinusGDeribitIv,
      fMeanFv,
      gMeanFv,
      fMinusGMeanFv,
      tradeSignalSigma5m: 0,
      tradeSignalSigma10m: 0,
      tradeSignalDeribitIv: 0,
      fSigma10m,
      gSigma10m,
      fMinusGSigma10m,
    });
  }

  for (let i = 0; i < computed.length; i++) {
    const row = computed[i];
    if (!row) continue;
    const sigma5mPass = sigmaRegimeOk(computed, i, 'annualizedSigma5m');
    const sigma10mPass = sigmaRegimeOk(computed, i, 'annualizedSigma10m');
    const deribitPass = deribitRegimeOk(computed, i, deribitAnnualVolatility);
    row.tradeSignalSigma5m = computeTradeSignal(row, row.fSigma5m, row.fMinusGSigma5m, sigma5mPass);
    row.tradeSignalSigma10m = computeTradeSignal(
      row,
      row.fSigma10m,
      row.fMinusGSigma10m,
      sigma10mPass,
    );
    row.tradeSignalDeribitIv = computeTradeSignal(
      row,
      row.fDeribitIv,
      row.fMinusGDeribitIv,
      deribitPass,
    );
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
    'chainlink_ts',
    'binance_ts',
    'binance_redis_ts',
    'fair_value_redis_ts',
    'time_to_expiry_ms',
    'time_to_expiry_sec',
    'strike_price',
    'chainlink_price',
    'binance_btcusdc_price',
    'annualized_sigma_5m',
    'annualized_sigma_10m',
    'fair_value_sigma_5m',
    'fair_value_sigma_10m',
    'fair_value_deribit_iv',
    'yes_bid',
    'yes_ask',
    'yes_execution_side',
    'yes_exec_price_raw',
    'yes_exec_price_fee_adj',
    'taker_fee_rate',
    'no_bid',
    'no_ask',
    'f_sigma_5m',
    'g_sigma_5m',
    'f_minus_g_sigma_5m',
    'trade_signal_sigma_5m',
    'f_sigma_10m',
    'g_sigma_10m',
    'f_minus_g_sigma_10m',
    'trade_signal_sigma_10m',
    'f_deribit_iv',
    'g_deribit_iv',
    'f_minus_g_deribit_iv',
    'trade_signal_deribit_iv',
  ];

  const lines = rows.map((row) =>
    [
      row.isoTime,
      String(row.chainlinkTs),
      row.binanceTs !== null && row.binanceTs !== undefined ? String(row.binanceTs) : '',
      row.binanceRedisTs !== null && row.binanceRedisTs !== undefined ? String(row.binanceRedisTs) : '',
      String(row.publishedAt),
      String(row.timeToExpiryMs),
      String(Math.round(row.timeToExpiryMs / 1000)),
      formatMaybeNumber(row.strikePrice, 2),
      formatNum(row.chainlinkPrice, 2),
      row.binancePrice !== null ? formatNum(row.binancePrice, 2) : '',
      formatMaybeNumber(row.annualizedSigma5m),
      formatMaybeNumber(row.annualizedSigma10m),
      formatMaybeNumber(row.fairValueSigma5m),
      formatMaybeNumber(row.fairValueSigma10m),
      formatMaybeNumber(row.fairValueDeribitIv),
      formatNum(row.yesBid),
      formatNum(row.yesAsk),
      row.yesExecutionSide,
      formatNum(row.yesTokenPrice),
      formatNum(row.yesTokenPriceFeeAdj),
      formatNum(TAKER_FEE_RATE, 6),
      formatNum(row.noBid),
      formatNum(row.noAsk),
      formatMaybeNumber(row.fSigma5m),
      formatMaybeNumber(row.gSigma5m),
      formatMaybeNumber(row.fMinusGSigma5m),
      String(row.tradeSignalSigma5m),
      formatMaybeNumber(row.fSigma10m),
      formatMaybeNumber(row.gSigma10m),
      formatMaybeNumber(row.fMinusGSigma10m),
      String(row.tradeSignalSigma10m),
      formatMaybeNumber(row.fDeribitIv),
      formatMaybeNumber(row.gDeribitIv),
      formatMaybeNumber(row.fMinusGDeribitIv),
      String(row.tradeSignalDeribitIv),
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
  lines.push(`- takerFeeRate: ${(TAKER_FEE_RATE * 100).toFixed(2)}%`);
  lines.push(`- csv: \`${relativeCsvPath}\``);
  lines.push('');
  lines.push('## Formula Notes');
  lines.push('');
  lines.push(
    '- `chainlink_price(t)` is diagnostic spot; fair value in this report uses Binance as **S**.',
  );
  lines.push(
    '- `binance_btcusdc_price(t)` is Binance book-ticker **mid** used as **S** in `fair_value_sigma_5m`, `fair_value_sigma_10m`, and `fair_value_deribit_iv`.',
  );
  lines.push(
    '- `annualized_sigma_5m` / `annualized_sigma_10m` are annualized EWMA sigma from 5-minute / 10-minute Chainlink samples.',
  );
  lines.push(
    '- `yes_exec_price_raw` selects ask for buy-side valuation and bid for sell-side valuation; `yes_exec_price_fee_adj` applies taker fee (buy: `raw*(1+fee)`, sell: `raw*(1-fee)`).',
  );
  lines.push(
    '- `f_sigma_5m = fair_value_sigma_5m - yes_exec_price_fee_adj`, `f_sigma_10m = fair_value_sigma_10m - yes_exec_price_fee_adj`, `f_deribit_iv = fair_value_deribit_iv - yes_exec_price_fee_adj`.',
  );
  lines.push(
    '- For each track, `g` is the mean of previous 10 `f` samples and `f_minus_g = f - g`.',
  );
  lines.push(
    '- `trade_signal_*` values are `1` (buy), `-1` (short), `0` (no trade), using the same conditions as backtest logic.',
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
    '| iso time | chainlink ts | binance ts | binance redis ts | fair value redis ts | tte ms | tte sec | strike | chainlink | binance | ann sigma 5m | ann sigma 10m | fv sigma 5m | fv sigma 10m | fv deribit iv | yes bid | yes ask | yes exec side | yes exec raw | yes exec fee adj | no bid | no ask | f sigma 5m | g sigma 5m | f-g sigma 5m | signal sigma 5m | f sigma 10m | g sigma 10m | f-g sigma 10m | signal sigma 10m | f deribit iv | g deribit iv | f-g deribit iv | signal deribit iv |',
  );
  lines.push(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const row of rows) {
    lines.push(
      `| ${row.isoTime} | ${row.chainlinkTs} | ${row.binanceTs ?? 'N/A'} | ${row.binanceRedisTs ?? 'N/A'} | ${row.publishedAt} | ` +
        `${row.timeToExpiryMs} | ${Math.round(row.timeToExpiryMs / 1000)} | ${formatMaybeNumber(row.strikePrice, 2)} | ` +
        `${formatNum(row.chainlinkPrice, 2)} | ${formatMaybeNumber(row.binancePrice, 2) || 'N/A'} | ` +
        `${formatMaybeNumber(row.annualizedSigma5m)} | ${formatMaybeNumber(row.annualizedSigma10m)} | ` +
        `${formatMaybeNumber(row.fairValueSigma5m)} | ${formatMaybeNumber(row.fairValueSigma10m)} | ${formatMaybeNumber(row.fairValueDeribitIv)} | ` +
        `${formatNum(row.yesBid)} | ${formatNum(row.yesAsk)} | ${row.yesExecutionSide} | ${formatNum(row.yesTokenPrice)} | ${formatNum(row.yesTokenPriceFeeAdj)} | ${formatNum(row.noBid)} | ${formatNum(row.noAsk)} | ` +
        `${formatMaybeNumber(row.fSigma5m)} | ${formatMaybeNumber(row.gSigma5m)} | ${formatMaybeNumber(row.fMinusGSigma5m)} | ${row.tradeSignalSigma5m} | ` +
        `${formatMaybeNumber(row.fSigma10m)} | ${formatMaybeNumber(row.gSigma10m)} | ${formatMaybeNumber(row.fMinusGSigma10m)} | ${row.tradeSignalSigma10m} | ` +
        `${formatMaybeNumber(row.fDeribitIv)} | ${formatMaybeNumber(row.gDeribitIv)} | ${formatMaybeNumber(row.fMinusGDeribitIv)} | ${row.tradeSignalDeribitIv} |`,
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
