/**
 * Shared math helpers for p_base-only fair value estimation.
 *
 * The fair value is the binary-call probability that BTC settles above the
 * market strike at expiry:
 *
 *   P(S_T > K) = N(d2)
 *
 * with risk-free rate fixed at 0:
 *
 *   d2 = [ln(S/K) - (sigma^2 / 2) * T] / (sigma * sqrt(T))
 *
 * where sigma is BTC volatility in per-second units and T is expressed in
 * seconds.
 */

/** Calendar seconds per year (365 days), for annualizing per-second sigma. */
export const SECONDS_PER_YEAR = 60 * 60 * 24 * 365;

/**
 * Convert EWMA per-second volatility to annualized (fractional) volatility.
 * annualized_sigma = sigma_per_second * sqrt(seconds_per_year)
 */
export function annualizedVolatilityFromPerSecond(perSecond: number): number {
  return perSecond * Math.sqrt(SECONDS_PER_YEAR);
}

/** Convert annualized fractional volatility (e.g. 0.40 for 40%) to per-second units. */
export function perSecondVolatilityFromAnnual(annual: number): number {
  return annual / Math.sqrt(SECONDS_PER_YEAR);
}

const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.99;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Standard-normal CDF via Abramowitz & Stegun polynomial.
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.sqrt(2)

  const t = 1.0 / (1.0 + p * absX)
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)

  return 0.5 * (1.0 + sign * y)
}

export interface BaseFairValueInput {
  currentPrice: number;
  strikePrice: number;
  timeToExpiryMs: number;
  perSecondVolatility: number;
}

export function adjustedPerSecondVolatilityFromCoarseAndDeribit(
  coarsePerSecond: number,
  deribitAnnual: number,
): number {
  const coarseAnnual = annualizedVolatilityFromPerSecond(coarsePerSecond);
  const adjustedAnnual = Math.max((coarseAnnual + deribitAnnual) * 0.5, deribitAnnual * 0.75);
  return perSecondVolatilityFromAnnual(adjustedAnnual);
}

/**
 * Binary-option p_base fair value under Black-Scholes with r = 0.
 */
export function computeBaseFairValue({
  currentPrice,
  strikePrice,
  timeToExpiryMs,
  perSecondVolatility,
}: BaseFairValueInput): number {
  if (currentPrice <= 0 || strikePrice <= 0 || perSecondVolatility <= 0) {
    return 0.5;
  }

  const timeToExpirySeconds = timeToExpiryMs / 1000;
  if (timeToExpirySeconds <= 0) {
    return currentPrice > strikePrice ? MAX_PROBABILITY : MIN_PROBABILITY;
  }

  const sigmaSqrtT = perSecondVolatility * Math.sqrt(timeToExpirySeconds);
  if (sigmaSqrtT < 1e-9) {
    return currentPrice > strikePrice ? MAX_PROBABILITY : MIN_PROBABILITY;
  }

  //  d2 = [ln(S/K) - (sigma^2 / 2) * T] / (sigma * sqrt(T))
  const varianceTerm = 0.5 * perSecondVolatility * perSecondVolatility * timeToExpirySeconds;
  const d2 = (Math.log(currentPrice / strikePrice) - varianceTerm) / sigmaSqrtT;

  return clamp(normalCDF(d2), MIN_PROBABILITY, MAX_PROBABILITY);
}

export interface ConfidenceResult {
  confidence: number;
  timeBonus: number;
  atFloor: boolean;
}

/** Time-to-expiry threshold where raw confidence reaches MIN_CONFIDENCE (60s). */
const MIN_CONFIDENCE_TTE_MS = 60_000;

/**
 * Confidence score based only on time-to-expiry.
 */
export function computeFairValueConfidence(
  timeToExpiryMs: number,
  minConfidence: number
): ConfidenceResult {
  const timeBonus = Math.min(1, (timeToExpiryMs / MIN_CONFIDENCE_TTE_MS) * minConfidence);
  const rawScore = timeBonus;
  const confidence = Math.max(minConfidence, rawScore);

  return {
    confidence,
    timeBonus,
    atFloor: rawScore < minConfidence,
  };
}
