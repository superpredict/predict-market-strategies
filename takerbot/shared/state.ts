import { FEED_TTL_SECONDS } from '../config/constants.js';
import { getRedisClient } from './redis.js';
import type {
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
