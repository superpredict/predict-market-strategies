import dotenv from 'dotenv';
import { Polymarket } from '@superpredict/ccxt';
import type { Market } from '@superpredict/ccxt';
import type { MarketConfig } from '../shared/types.js';
import {
  EDGE_THRESHOLD,
  MAX_EXPOSURE_USDC,
  MAX_TIME_TO_EXPIRY_MS,
  MIN_MARKET_LIQUIDITY,
  MIN_TIME_TO_EXPIRY_MS,
  POSITION_SIZE_USDC,
} from './constants.js';

dotenv.config();

// ─── Secrets from .env ────────────────────────────────────────────────────────

const DRY_RUN = process.env['DRY_RUN'] !== 'false'; // default true for safety

// ─── Market discovery ─────────────────────────────────────────────────────────

/**
 * Search Polymarket for the currently active BTC 15-minute market.
 *
 * Polymarket generates rolling "Will BTC be above $X at HH:MM UTC?" markets
 * that expire every 15 minutes. We find the one expiring soonest but still
 * at least 2 minutes in the future (enough time to trade).
 *
 * Falls back to any open BTC binary market with close time ≤ 30 min away.
 */
export async function findActiveBtc15MinMarket(
  exchange: Polymarket
): Promise<{ market: Market; config: MarketConfig } | null> {
  const now = Date.now();

  const markets = await exchange.searchMarkets({
    limit: 200,
    closed: false,
    query: 'BTC',
    binary: true,
    minLiquidity: MIN_MARKET_LIQUIDITY,
  });

  const btcMarkets = markets.filter((m) => {
    if (!m.closeTime) return false;
    const tte = m.closeTime.getTime() - now;
    return tte >= MIN_TIME_TO_EXPIRY_MS && tte <= MAX_TIME_TO_EXPIRY_MS;
  });

  // Sort by closest to expiry first
  btcMarkets.sort((a, b) => {
    const ta = a.closeTime?.getTime() ?? 0;
    const tb = b.closeTime?.getTime() ?? 0;
    return ta - tb;
  });

  const market = btcMarkets[0];
  if (!market) return null;

  const tokenIds = (market.metadata.clobTokenIds as string[] | undefined) ?? [];
  if (tokenIds.length < 2) return null;

  const yesTokenId = tokenIds[0] ?? '';
  const noTokenId = tokenIds[1] ?? '';

  const strikePrice = extractStrikePrice(market.question);

  const config: MarketConfig = {
    marketId: market.id,
    question: market.question,
    yesTokenId,
    noTokenId,
    strikePrice,
    expiryTime: market.closeTime!,
    positionSizeUsdc: POSITION_SIZE_USDC,
    edgeThreshold: EDGE_THRESHOLD,
    maxExposureUsdc: MAX_EXPOSURE_USDC,
    dryRun: DRY_RUN,
  };

  return { market, config };
}

/**
 * Build a MarketConfig from an explicitly provided condition ID.
 * Use this when you already know the market ID (e.g. from the Polymarket UI).
 */
export async function buildMarketConfig(
  exchange: Polymarket,
  conditionId: string
): Promise<MarketConfig> {
  const market = await exchange.fetchMarket(conditionId);

  const tokenIds = (market.metadata.clobTokenIds as string[] | undefined) ?? [];
  if (tokenIds.length < 2) {
    throw new Error(`Market ${conditionId} does not have 2 token IDs`);
  }

  const yesTokenId = tokenIds[0] ?? '';
  const noTokenId = tokenIds[1] ?? '';
  const strikePrice = extractStrikePrice(market.question);

  return {
    marketId: conditionId,
    question: market.question,
    yesTokenId,
    noTokenId,
    strikePrice,
    expiryTime: market.closeTime ?? new Date(Date.now() + 15 * 60 * 1000),
    positionSizeUsdc: POSITION_SIZE_USDC,
    edgeThreshold: EDGE_THRESHOLD,
    maxExposureUsdc: MAX_EXPOSURE_USDC,
    dryRun: DRY_RUN,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the strike price (USD) from a market question like:
 *   "Will Bitcoin be above $95,000 at 14:15 UTC?"
 *   "Will BTC reach $100,000 by Friday?"
 * Returns null if no strike price is found (e.g. "Up or Down" markets).
 */
function extractStrikePrice(question: string): number | null {
  const match = /\$\s*([\d,]+(?:\.\d+)?)/i.exec(question);
  if (!match) return null;
  const raw = match[1]?.replace(/,/g, '') ?? '';
  const price = Number.parseFloat(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}
