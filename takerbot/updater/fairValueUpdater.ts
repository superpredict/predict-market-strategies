/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger it computes the fair value (probability that "Yes"
 * resolves) and publishes to fv:updated:{conditionId}.
 *
 * Fair Value Models:
 *
 *   STRIKE model  — "Will BTC be above $K?" markets
 *     FV = clamp(0.5 + (S - K) / K × FV_SCALE, 0.05, 0.95)
 *
 *   MOMENTUM model — "BTC Up or Down in 15 min?" markets (no strike)
 *     FV = clamp(0.5 + momentum × MOMENTUM_SCALE, 0.07, 0.93)
 *     where momentum = (currentPrice − price5MinAgo) / price5MinAgo
 *     price5MinAgo is read from the rolling BTC price history in Redis.
 *
 * Market identity is NOT passed via CLI args. Instead, this process:
 *   1. Reads the current active market from Redis key  market:active-btc15m
 *      at start-up (written by marketDiscovery).
 *   2. Subscribes to Redis channel  market:new-active-market  so it
 *      hot-swaps to the next 15-min market without restarting.
 *
 * Run as a standalone process via PM2 (one instance):
 *   node --import tsx/esm takerbot/updater/fairValueUpdater.ts
 */

import dotenv from 'dotenv';
import {
  FV_SCALE,
  MIN_CONFIDENCE,
  MOMENTUM_LOOKBACK_MS,
  MOMENTUM_SCALE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
} from '../config/constants.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import {
  getActiveMarket,
  getBtcPrice,
  getBtcPriceMsAgo,
  getOrderbook,
  setFairValue,
} from '../shared/state.js';
import {
  REDIS_CHANNELS,
  type ActiveMarketInfo,
  type BtcPriceFeed,
  type FairValue,
  type MarketOrderbookFeed,
} from '../shared/types.js';

dotenv.config();

// ─── Mutable market state (updated on each rotation) ─────────────────────────

let MARKET_ID: string | null = null;
let STRIKE_PRICE: number | null = null;
let EXPIRY_TS: number | null = null;

// ─── Fair value math ──────────────────────────────────────────────────────────

/**
 * Linear fair value for "BTC above $K?" markets.
 *   FV = clamp(0.5 + (S - K) / K × FV_SCALE, 0.05, 0.95)
 */
function computeStrikeFairValue(currentPrice: number, strikePrice: number): number {
  const relativeDistance = (currentPrice - strikePrice) / strikePrice;
  return Math.min(0.95, Math.max(0.05, 0.5 + relativeDistance * FV_SCALE));
}

/**
 * Momentum fair value for "Up or Down" markets (no strike price).
 *   FV = clamp(0.5 + momentum × MOMENTUM_SCALE, 0.07, 0.93)
 *   momentum = (currentPrice − price5MinAgo) / price5MinAgo
 *
 * Returns 0.5 (no edge) if historical price is unavailable.
 */
function computeMomentumFairValue(currentPrice: number, oldPrice: number | null): number {
  if (!oldPrice || oldPrice <= 0) {
    console.log(`[fairValueUpdater] no old price, using 0.5`);
    return 0.5;
  }
  const momentum = (currentPrice - oldPrice) / oldPrice;
  return Math.min(0.93, Math.max(0.07, 0.5 + momentum * MOMENTUM_SCALE));
}

/**
 * Confidence degrades as data goes stale or time-to-expiry shrinks.
 */
function computeConfidence(btcTs: number, obTs: number, timeToExpiryMs: number): number {
  const now = Date.now();
  
  const btcStaleness = Math.max(0, 1 - (now - btcTs) / 8000);   
  const obStaleness  = Math.max(0, 1 - (now - obTs) / 15000);  

  const timeBonus = Math.min(1, timeToExpiryMs / 600_000);     

  let conf = Math.min(btcStaleness, obStaleness) * timeBonus;

  // Important: Add a minimum safety margin to avoid a complete loss to zero
  conf = Math.max(0.15, conf); // Reserve at least 0.15

  return conf;
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: BtcPriceFeed,
  obFeed: MarketOrderbookFeed
): Promise<void> {
  if (!MARKET_ID) return;

  const now = Date.now();
  const expiryMs = EXPIRY_TS ?? now + 15 * 60 * 1000;
  const timeToExpiryMs = expiryMs - now;

  let value: number;
  let modelType: string;

  if (STRIKE_PRICE !== null && STRIKE_PRICE > 0) {
    value = computeStrikeFairValue(btcFeed.price, STRIKE_PRICE);
    modelType = 'STRIKE';
  } else {
    const oldPrice = await getBtcPriceMsAgo(MOMENTUM_LOOKBACK_MS);
    value = computeMomentumFairValue(btcFeed.price, oldPrice);
    modelType = 'MOMENTUM';
  }

  const confidence = computeConfidence(btcFeed.ts, obFeed.ts, timeToExpiryMs);

  if (confidence < MIN_CONFIDENCE) {
    const btcStale = ((Date.now() - btcFeed.ts) / 1000).toFixed(1);
    const obStale = ((Date.now() - obFeed.ts) / 1000).toFixed(1);
    const tte = Math.round(timeToExpiryMs / 1000);
  
    console.log(
      `[fairValueUpdater] LOW CONFIDENCE ${confidence.toFixed(2)} ` +
      `(btcStale:${btcStale}s, obStale:${obStale}s, tte:${tte}s) — skipping`
    );
    return;
  }

  const fv: FairValue = {
    marketId: MARKET_ID,
    value,
    confidence,
    btcPrice: btcFeed.price,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    ts: now,
  };

  await setFairValue(fv);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.fairValueUpdated(MARKET_ID), JSON.stringify(fv));

  console.log(
    `[fairValueUpdater] ${modelType} FV=${(value * 100).toFixed(2)}% ` +
    `conf=${(confidence * 100).toFixed(0)}% ` +
    `btc=$${btcFeed.price.toFixed(2)} ` +
    `tte=${Math.round(timeToExpiryMs / 1000)}s`
  );
}

// ─── Market rotation ──────────────────────────────────────────────────────────

let isProcessing = false;

async function rotateToMarket(sub: ReturnType<typeof getSubscriberClient>, info: ActiveMarketInfo): Promise<void> {
  const newMarketId = info.conditionId;

  if (newMarketId === MARKET_ID) {
    console.log(`[fairValueUpdater] already on market ${newMarketId.slice(0, 10)}…, skipping`);
    return;
  }

  console.log(
    `[fairValueUpdater] rotating to market ${newMarketId.slice(0, 10)}… "${info.question}"`
  );

  // Unsubscribe from old orderbook channel
  if (MARKET_ID) {
    await sub.unsubscribe(REDIS_CHANNELS.orderbookUpdated(MARKET_ID));
  }

  // Update mutable state
  MARKET_ID = newMarketId;
  STRIKE_PRICE = info.strikePrice;
  EXPIRY_TS = info.expiryTs;

  // Subscribe to new orderbook channel
  await sub.subscribe(REDIS_CHANNELS.orderbookUpdated(MARKET_ID));

  console.log(
    `[fairValueUpdater] subscribed to orderbook for market ${MARKET_ID.slice(0, 10)}… ` +
    `strike=${STRIKE_PRICE ?? 'N/A'} expiry=${info.endDate}`
  );
}

// ─── Redis subscription ───────────────────────────────────────────────────────

async function start(): Promise<void> {
  const sub = getSubscriberClient();

  const btcChannel = REDIS_CHANNELS.btcPriceUpdated;
  const discoveryChannel = REDIS_CHANNELS.newActiveMarket;

  await sub.subscribe(btcChannel, discoveryChannel);
  console.log(
    `[fairValueUpdater] subscribed to ${btcChannel} and ${discoveryChannel}`
  );

  sub.on('message', (channel: string, message: string) => {
    void (async () => {
      try {
        if (channel === discoveryChannel) {
          const info = JSON.parse(message) as ActiveMarketInfo;
          await rotateToMarket(sub, info);
          return;
        }

        if (!MARKET_ID) return; // no active market yet
        if (isProcessing) return;
        isProcessing = true;

        try {
          if (channel === btcChannel) {
            const btcFeed = JSON.parse(message) as BtcPriceFeed;
            const obFeed = await getOrderbook(MARKET_ID);
            if (!obFeed) return;
            await computeAndPublish(btcFeed, obFeed);
          } else if (channel === REDIS_CHANNELS.orderbookUpdated(MARKET_ID)) {
            const obFeed = JSON.parse(message) as MarketOrderbookFeed;
            const btcFeed = await getBtcPrice();
            if (!btcFeed) return;
            await computeAndPublish(btcFeed, obFeed);
          }
        } finally {
          isProcessing = false;
        }
      } catch (err) {
        isProcessing = false;
        console.error('[fairValueUpdater] error:', err);
      }
    })();
  });

  // Cold-start: try to load the already-known active market from Redis
  const existing = await getActiveMarket();
  if (existing) {
    console.log('[fairValueUpdater] found existing active market in Redis, activating…');
    await rotateToMarket(sub, existing);
  } else {
    console.log(
      '[fairValueUpdater] no active market in Redis yet — waiting for marketDiscovery…'
    );
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[fairValueUpdater] shutting down…');
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

start().catch((err) => {
  console.error('[fairValueUpdater] fatal:', err);
  process.exit(1);
});
