import { FEED_TTL_SECONDS } from '../config/constants.js';
import { getRedisClient } from './redis.js';
import type {
  ActiveMarketInfo,
  BtcPriceFeed,
  FairValue,
  MarketOrderbookFeed,
  PortfolioPosition,
  PortfolioSnapshot,
} from './types.js';
import { REDIS_KEYS } from './types.js';

// ─── BTC Price ────────────────────────────────────────────────────────────────

export async function setBtcPrice(feed: BtcPriceFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.btcPrice, JSON.stringify(feed), 'EX', FEED_TTL_SECONDS);
}

export async function getBtcPrice(): Promise<BtcPriceFeed | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.btcPrice);
  return raw ? (JSON.parse(raw) as BtcPriceFeed) : null;
}

// ─── Market Orderbook ─────────────────────────────────────────────────────────

export async function setOrderbook(feed: MarketOrderbookFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.set(
    REDIS_KEYS.orderbook(feed.marketId),
    JSON.stringify(feed),
    'EX',
    FEED_TTL_SECONDS
  );
}

export async function getOrderbook(marketId: string): Promise<MarketOrderbookFeed | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.orderbook(marketId));
  return raw ? (JSON.parse(raw) as MarketOrderbookFeed) : null;
}

// ─── Fair Value ───────────────────────────────────────────────────────────────

export async function setFairValue(fv: FairValue): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.fairValue(fv.marketId), JSON.stringify(fv), 'EX', FEED_TTL_SECONDS);
}

export async function getFairValue(marketId: string): Promise<FairValue | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.fairValue(marketId));
  return raw ? (JSON.parse(raw) as FairValue) : null;
}

// ─── Position ─────────────────────────────────────────────────────────────────

export async function setPosition(pos: PortfolioPosition): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.position(pos.marketId), JSON.stringify(pos), 'EX', 86400);
}

export async function getPosition(marketId: string): Promise<PortfolioPosition | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.position(marketId));
  return raw ? (JSON.parse(raw) as PortfolioPosition) : null;
}

// ─── Portfolio Snapshot ───────────────────────────────────────────────────────

export async function setPortfolioSnapshot(snap: PortfolioSnapshot): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.portfolio, JSON.stringify(snap), 'EX', 86400);
}

export async function getPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.portfolio);
  return raw ? (JSON.parse(raw) as PortfolioSnapshot) : null;
}

// ─── Active Market ────────────────────────────────────────────────────────────

export async function setActiveMarket(info: ActiveMarketInfo): Promise<void> {
  const redis = getRedisClient();
  // TTL = 30 min (two windows), so a cold-starting process can always find it
  await redis.set(REDIS_KEYS.activeMarket, JSON.stringify(info), 'EX', 1800);
}

export async function getActiveMarket(): Promise<ActiveMarketInfo | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.activeMarket);
  return raw ? (JSON.parse(raw) as ActiveMarketInfo) : null;
}

// ─── Historical BTC Prices (momentum lookback) ────────────────────────────────

interface BtcPriceEntry {
  price: number;
  ts: number;
}

/**
 * Append current BTC price with timestamp to a rolling list.
 * Keeps only the latest 20 entries — more than enough for a 5-min lookback.
 */
export async function appendBtcPriceHistory(price: number): Promise<void> {
  const redis = getRedisClient();
  const entry: BtcPriceEntry = { price, ts: Date.now() };
  await redis.lpush(REDIS_KEYS.btcPriceHistory, JSON.stringify(entry));
  await redis.ltrim(REDIS_KEYS.btcPriceHistory, 0, 19);
}

export async function getBtcPriceMsAgo(
  targetMsAgo: number = 5 * 60 * 1000
): Promise<number | null> {
  const redis = getRedisClient();
  const rawList = await redis.lrange(REDIS_KEYS.btcPriceHistory, 0, -1);

  if (rawList.length === 0) {
    console.log('[getBtcPriceMsAgo] ❌ history list is completely empty');
    return null;
  }

  console.log(`[getBtcPriceMsAgo] 📊 Found ${rawList.length} history entries`);

  const targetTime = Date.now() - targetMsAgo;
  let closestPrice: number | null = null;
  let closestDiff = Infinity;

  for (const raw of rawList) {
    const entry = JSON.parse(raw) as BtcPriceEntry;
    const diff = Math.abs(entry.ts - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestPrice = entry.price;
    }
  }

  console.log(`[getBtcPriceMsAgo] closestDiff: ${closestDiff}`);

  const ageInSeconds = (closestDiff / 1000).toFixed(1);

  // Further relaxed tolerance to ±300 seconds (5 minutes)
  const toleranceMs = 300_000;

  console.log(
    `[getBtcPriceMsAgo] 🔍 Target: ${targetMsAgo/1000}s ago | Closest: ${ageInSeconds}s ago | Price: ${closestPrice}`
  );
  
  if (closestDiff <= toleranceMs) {
    console.log(`[getBtcPriceMsAgo] ✅ SUCCESS - Using price ${closestPrice} (${ageInSeconds}s ago)`);
    return closestPrice;
  } else {
    console.log(`[getBtcPriceMsAgo] ⚠️ TOO OLD (${ageInSeconds}s > ${toleranceMs/1000}s), using fallback 0.5`);
    return null;
  }
}
