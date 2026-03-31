/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger it computes the fair value (probability that "Yes"
 * resolves) and publishes to fv:updated:{conditionId}.
 *
 * This process supports automatic market rotation via Redis without restarting.
 */

import dotenv from 'dotenv';
import {
  FV_SCALE,
  MIN_CONFIDENCE,
  MOMENTUM_LOOKBACK_MS,        // Will be set to 2 minutes below
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

// ─── Mutable market state (updated on each market rotation) ───────────────────

let MARKET_ID: string | null = null;
let STRIKE_PRICE: number | null = null;
let EXPIRY_TS: number | null = null;

// ─── Fair Value Calculation Functions ────────────────────────────────────────

/**
 * Linear fair value for "Will BTC be above $K?" markets (STRIKE model).
 */
function computeStrikeFairValue(currentPrice: number, strikePrice: number): number {
  const relativeDistance = (currentPrice - strikePrice) / strikePrice;
  return Math.min(0.95, Math.max(0.05, 0.5 + relativeDistance * FV_SCALE));
}

/**
 * Hybrid Fair Value Model (45% BTC Momentum + 55% Yes token market price)
 */
function computeHybridFairValue(
  currentBtcPrice: number,
  oldBtcPrice: number | null,
  yesTokenPrice: number,
  timeToExpiryMs: number
): number {
  if (!oldBtcPrice || oldBtcPrice <= 0) {
    console.log(`[fairValueUpdater] no old BTC price, falling back to yesTokenPrice`);
    return Math.max(0.07, Math.min(0.93, yesTokenPrice));
  }

  const momentum = (currentBtcPrice - oldBtcPrice) / oldBtcPrice;
  const timeWeight = Math.max(1, 3.0 - (timeToExpiryMs / 900_000));

  const momentumFV = 0.5 + momentum * MOMENTUM_SCALE * timeWeight;
  const clampedMomentumFV = Math.min(0.93, Math.max(0.07, momentumFV));

  const hybridFV = clampedMomentumFV * 0.45 + yesTokenPrice * 0.55;

  return Math.min(0.93, Math.max(0.07, hybridFV));
}

/**
 * Confidence - Final optimized version
 * 
 * Major fix: Extended timeBonus baseline to 40 minutes so that even at tte=150s,
 * timeBonus is still reasonable (~0.25+).
 */
function computeConfidence(btcTs: number, obTs: number, timeToExpiryMs: number): number {
  const now = Date.now();

  const btcStaleness = Math.max(0, 1 - (now - btcTs) / 25000);   // 25 seconds
  const obStaleness  = Math.max(0, 1 - (now - obTs) / 20000);    // 20 seconds

  const timeBonus = Math.min(1, timeToExpiryMs / 2400000);

  let conf = Math.min(btcStaleness, obStaleness) * timeBonus;
  conf = Math.max(0.18, conf);   // minimum floor

  return conf;
}

// ─── Core Computation ────────────────────────────────────────────────────────

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
    const yesTokenPrice = obFeed.bestAsk || obFeed.bestBid || 0.5;

    value = computeHybridFairValue(btcFeed.price, oldPrice, yesTokenPrice, timeToExpiryMs);
    modelType = 'HYBRID_MOMENTUM';
  }

  const confidence = computeConfidence(btcFeed.ts, obFeed.ts, timeToExpiryMs);

  // Detailed low-confidence logging with exact reasons
  if (confidence < MIN_CONFIDENCE) {
    const btcStaleSec = ((Date.now() - btcFeed.ts) / 1000).toFixed(1);
    const obStaleSec = ((Date.now() - obFeed.ts) / 1000).toFixed(1);
    const tteSec = Math.round(timeToExpiryMs / 1000);

    // Calculate individual components for debugging
    const btcStaleness = Math.max(0, 1 - (Date.now() - btcFeed.ts) / 20000);
    const obStaleness = Math.max(0, 1 - (Date.now() - obFeed.ts) / 20000);
    const timeBonus = Math.min(1, timeToExpiryMs / 1200000);

    console.log(
      `[fairValueUpdater] LOW CONFIDENCE ${confidence.toFixed(2)} ` +
      `(btcStale:${btcStaleSec}s → staleness=${btcStaleness.toFixed(2)}, ` +
      `obStale:${obStaleSec}s → staleness=${obStaleness.toFixed(2)}, ` +
      `timeBonus=${timeBonus.toFixed(2)}, tte:${tteSec}s) — skipping`
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

  // Normal log with Yes token price
  console.log(
    `[fairValueUpdater] ${modelType} FV=${(value * 100).toFixed(2)}% ` +
    `conf=${(confidence * 100).toFixed(0)}% ` +
    `btc=$${btcFeed.price.toFixed(2)} ` +
    `yesPrice=${(obFeed.bestAsk || 0).toFixed(4)} ` +
    `tte=${Math.round(timeToExpiryMs / 1000)}s`
  );
}

// ─── Market Rotation ─────────────────────────────────────────────────────────

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

  if (MARKET_ID) {
    await sub.unsubscribe(REDIS_CHANNELS.orderbookUpdated(MARKET_ID));
  }

  MARKET_ID = newMarketId;
  STRIKE_PRICE = info.strikePrice;
  EXPIRY_TS = info.expiryTs;

  await sub.subscribe(REDIS_CHANNELS.orderbookUpdated(MARKET_ID));

  console.log(
    `[fairValueUpdater] subscribed to orderbook for market ${MARKET_ID.slice(0, 10)}… ` +
    `strike=${STRIKE_PRICE ?? 'N/A'} expiry=${info.endDate}`
  );
}

// ─── Redis Subscriptions and Main Loop ───────────────────────────────────────

async function start(): Promise<void> {
  const sub = getSubscriberClient();

  const btcChannel = REDIS_CHANNELS.btcPriceUpdated;
  const discoveryChannel = REDIS_CHANNELS.newActiveMarket;

  await sub.subscribe(btcChannel, discoveryChannel);
  console.log(`[fairValueUpdater] subscribed to ${btcChannel} and ${discoveryChannel}`);

  sub.on('message', (channel: string, message: string) => {
    void (async () => {
      try {
        if (channel === discoveryChannel) {
          const info = JSON.parse(message) as ActiveMarketInfo;
          await rotateToMarket(sub, info);
          return;
        }

        if (!MARKET_ID || isProcessing) return;
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

  const existing = await getActiveMarket();
  if (existing) {
    console.log('[fairValueUpdater] found existing active market in Redis, activating…');
    await rotateToMarket(sub, existing);
  } else {
    console.log('[fairValueUpdater] no active market in Redis yet — waiting for marketDiscovery…');
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

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