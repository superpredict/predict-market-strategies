import { FEED_TTL_SECONDS } from '../config/constants.js';
import { getRedisClient } from './redis.js';
import type {
  ActiveMarketInfo,
  BtcPriceFeed,
  ChainlinkBtcPriceFeed,
  FairValue,
  MarketReportPoint,
  MarketOrderbookFeed,
  PortfolioPosition,
  PortfolioSnapshot,
} from './types.js';
import { REDIS_CHANNELS, REDIS_KEYS } from './types.js';

// ─── BTC Price ────────────────────────────────────────────────────────────────

export async function setBtcPrice(feed: BtcPriceFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.btcPrice, JSON.stringify(feed), 'EX', FEED_TTL_SECONDS);
}

/**
 * Append a Binance BTC mid snapshot to the rolling history list (for Redis-backed diff reports).
 * Same length/TTL policy as Chainlink history so seconds align for pairing.
 */
export async function appendBtcPriceHistory(feed: BtcPriceFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.lpush(REDIS_KEYS.btcPriceHistory, JSON.stringify(feed));
  await redis.ltrim(REDIS_KEYS.btcPriceHistory, 0, 1799);
  await redis.expire(REDIS_KEYS.btcPriceHistory, 2700);
}

export async function getBtcPriceHistory(): Promise<BtcPriceFeed[]> {
  const redis = getRedisClient();
  const rawList = await redis.lrange(REDIS_KEYS.btcPriceHistory, 0, -1);
  return rawList.map((raw: string) => JSON.parse(raw) as BtcPriceFeed);
}

export async function getChainlinkBtcPriceHistory(): Promise<ChainlinkBtcPriceFeed[]> {
  const redis = getRedisClient();
  const rawList = await redis.lrange(REDIS_KEYS.chainlinkBtcPriceHistory, 0, -1);
  return rawList.map((raw: string) => JSON.parse(raw) as ChainlinkBtcPriceFeed);
}

export async function getBtcPrice(): Promise<BtcPriceFeed | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.btcPrice);
  return raw ? (JSON.parse(raw) as BtcPriceFeed) : null;
}

/** Stamp the Unix second at which the last Binance WS frame was received. TTL = 60 s. */
export async function setBtcWsLastReceivedSec(tsSec: number): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.btcWsLastReceivedSec, String(tsSec), 'EX', 60);
}

export async function getBtcWsLastReceivedSec(): Promise<number | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.btcWsLastReceivedSec);
  return raw ? Number(raw) : null;
}

// ─── Chainlink BTC Price ──────────────────────────────────────────────────────

export async function setChainlinkBtcPrice(feed: ChainlinkBtcPriceFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.set(REDIS_KEYS.chainlinkBtcPrice, JSON.stringify(feed), 'EX', FEED_TTL_SECONDS * 2);
}

export async function getChainlinkBtcPrice(): Promise<ChainlinkBtcPriceFeed | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.chainlinkBtcPrice);
  return raw ? (JSON.parse(raw) as ChainlinkBtcPriceFeed) : null;
}

const WINDOW_SECONDS = 900; // 15-minute Polymarket window

/**
 * Append a Chainlink BTC price entry to the rolling history list.
 *
 * The Chainlink feed publishes roughly every second, so we keep 1800 entries
 * (~30 min) to ensure the exact 15-minute boundary second is always present.
 */
export async function appendChainlinkPriceHistory(feed: ChainlinkBtcPriceFeed): Promise<void> {
  const redis = getRedisClient();
  await redis.lpush(REDIS_KEYS.chainlinkBtcPriceHistory, JSON.stringify(feed));
  await redis.ltrim(REDIS_KEYS.chainlinkBtcPriceHistory, 0, 1799);
  await redis.expire(REDIS_KEYS.chainlinkBtcPriceHistory, 2700); // TTL 45 min
}

/**
 * Return the Chainlink BTC price whose chainlinkTs falls exactly on a
 * 15-minute boundary AND matches windowTs.
 *
 * Legacy helper retained for diagnostics and price-comparison tooling.
 * marketDiscovery now sources strikePrice from Vatic's active-target API
 * instead of this Redis-backed Chainlink history lookup.
 *
 * Returns null if no exact boundary entry is found (chainlinkPriceFeeder was
 * not running at that second).
 */
export async function getChainlinkStrikeForWindow(windowTs: number): Promise<number | null> {
  const redis = getRedisClient();
  const rawList = await redis.lrange(REDIS_KEYS.chainlinkBtcPriceHistory, 0, -1);

  if (rawList.length === 0) {
    console.warn('[getChainlinkStrikeForWindow] ⚠️ history list is empty');
    return null;
  }

  for (const raw of rawList) {
    const entry = JSON.parse(raw) as ChainlinkBtcPriceFeed;
    const entryTsSec = Math.floor(entry.chainlinkTs / 1000);

    // Exact 15-min boundary: timestamp divisible by 900 AND equals the window start
    if (entryTsSec % WINDOW_SECONDS === 0 && entryTsSec === windowTs) {
      console.log(
        `[getChainlinkStrikeForWindow] ✅ strike=$${entry.price} ` +
        `(chainlinkTs=${entry.chainlinkTs} exactly at windowTs=${windowTs})`
      );
      return entry.price;
    }
  }

  console.warn(
    `[getChainlinkStrikeForWindow] ⚠️ no exact boundary entry for windowTs=${windowTs} ` +
    `in ${rawList.length} history entries — chainlinkPriceFeeder may have been offline at that second`
  );
  return null;
}

// ─── Market Orderbook ─────────────────────────────────────────────────────────

/**
 * Depth-pressure signal payload published to depthPressureUpdated channel.
 * signal: 1 = bid depth surged, -1 = ask depth surged, 0 = reset to neutral.
 */
export interface DepthPressurePayload {
  marketId: string;
  signal: number;
  ts: number;
}

/** TTL (seconds) for the depth-pressure Redis key. */
const DEPTH_PRESSURE_TTL_SEC = 120;

/**
 * Write the depth-pressure signal for a market.
 * Also publishes to the depthPressureUpdated channel so subscribers are notified immediately.
 */
export async function setDepthPressure(
  redis: import('ioredis').Redis,
  marketId: string,
  signal: number,
): Promise<void> {
  await redis.set(
    REDIS_KEYS.depthPressure(marketId),
    String(signal),
    'EX',
    DEPTH_PRESSURE_TTL_SEC,
  );
  await redis.publish(
    REDIS_CHANNELS.depthPressureUpdated(marketId),
    JSON.stringify({ marketId, signal, ts: Date.now() } satisfies DepthPressurePayload),
  );
}

/** Read the current depth-pressure signal (0 if key is absent / expired). */
export async function getDepthPressure(marketId: string): Promise<number> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.depthPressure(marketId));
  return raw !== null ? Number(raw) : 0;
}

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

const MARKET_REPORT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MARKET_REPORT_MAX_ROWS = 5_000;

export async function appendMarketReportRow(row: MarketReportPoint): Promise<void> {
  const redis = getRedisClient();
  const key = REDIS_KEYS.marketReportRows(row.marketId);
  await redis.lpush(key, JSON.stringify(row));
  await redis.ltrim(key, 0, MARKET_REPORT_MAX_ROWS - 1);
  await redis.expire(key, MARKET_REPORT_TTL_SECONDS);
}

export async function getMarketReportRows(marketId: string): Promise<MarketReportPoint[]> {
  const redis = getRedisClient();
  const rawList = await redis.lrange(REDIS_KEYS.marketReportRows(marketId), 0, -1);
  return rawList.reverse().map((raw) => JSON.parse(raw) as MarketReportPoint);
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
  await redis.set(REDIS_KEYS.marketInfo(info.conditionId), JSON.stringify(info), 'EX', MARKET_REPORT_TTL_SECONDS);
  await redis.set(REDIS_KEYS.marketInfoBySlug(info.slug), info.conditionId, 'EX', MARKET_REPORT_TTL_SECONDS);
}

export async function getActiveMarket(): Promise<ActiveMarketInfo | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.activeMarket);
  return raw ? (JSON.parse(raw) as ActiveMarketInfo) : null;
}

export async function getMarketInfo(marketId: string): Promise<ActiveMarketInfo | null> {
  const redis = getRedisClient();
  const raw = await redis.get(REDIS_KEYS.marketInfo(marketId));
  return raw ? (JSON.parse(raw) as ActiveMarketInfo) : null;
}

export async function getMarketInfoBySlug(slug: string): Promise<ActiveMarketInfo | null> {
  const redis = getRedisClient();
  const marketId = await redis.get(REDIS_KEYS.marketInfoBySlug(slug));
  if (!marketId) return null;
  return getMarketInfo(marketId);
}

