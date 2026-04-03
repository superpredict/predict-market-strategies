/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger it computes the fair value (probability that "Yes"
 * resolves) and publishes to fv:updated:{conditionId}.
 *
 * Model: STRIKE only.
 *   FV = clamp(0.5 + (S − K) / K × FV_SCALE, 0.05, 0.95)
 *   K = Chainlink BTC/USD price at window open (set by marketDiscovery)
 *   S = current Binance BTC mid price
 *
 * BTC staleness guard:
 *   If the BTC feed is older than BTC_STALE_FORBID_MS, trading is hard-forbidden
 *   (early return). Confidence therefore only reflects orderbook freshness and
 *   time-to-expiry.
 */

import dotenv from 'dotenv';
import {
  BTC_STALE_FORBID_MS,
  FV_SCALE,
  MIN_CONFIDENCE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
} from '../config/constants.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import {
  getActiveMarket,
  getBtcPrice,
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

// ─── Fair Value Calculation ───────────────────────────────────────────────────

/**
 * FV = clamp(0.5 + (S − K) / K × FV_SCALE, 0.05, 0.95)
 */
function computeStrikeFairValue(currentPrice: number, strikePrice: number): number {
  const relativeDistance = (currentPrice - strikePrice) / strikePrice;
  return Math.min(0.95, Math.max(0.05, 0.5 + relativeDistance * FV_SCALE));
}

/**
 * Confidence score based on orderbook freshness and time-to-expiry.
 * BTC staleness is handled upstream via a hard forbid, not here.
 */
function computeConfidence(obTs: number, timeToExpiryMs: number): number {
  const now = Date.now();
  const obStaleness = Math.max(0, 1 - (now - obTs) / 20_000); // 20 s window
  const timeBonus = Math.min(1, timeToExpiryMs / 2_400_000);
  return Math.max(0.18, obStaleness * timeBonus);
}

// ─── Core Computation ────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: BtcPriceFeed,
  obFeed: MarketOrderbookFeed
): Promise<void> {
  if (!MARKET_ID) return;

  const now = Date.now();

  // ── Hard-forbid on stale BTC ──────────────────────────────────────────────
  const btcAgeMs = now - btcFeed.ts;
  if (btcAgeMs > BTC_STALE_FORBID_MS) {
    console.log(
      `[fairValueUpdater] STALE BTC (${(btcAgeMs / 1000).toFixed(1)}s > ` +
      `${BTC_STALE_FORBID_MS / 1000}s) — forbidden`
    );
    return;
  }

  // ── Require a valid strike price ──────────────────────────────────────────
  if (STRIKE_PRICE === null) {
    console.log('[fairValueUpdater] no strike price — forbidden (chainlink feeder not running?)');
    return;
  }

  const expiryMs = EXPIRY_TS ?? now + 15 * 60 * 1000;
  const timeToExpiryMs = expiryMs - now;

  if (timeToExpiryMs < STOP_TRADING_BEFORE_EXPIRY_MS) return;

  const value = computeStrikeFairValue(btcFeed.price, STRIKE_PRICE);
  const confidence = computeConfidence(obFeed.ts, timeToExpiryMs);

  if (confidence < MIN_CONFIDENCE) {
    const obStaleSec = ((now - obFeed.ts) / 1000).toFixed(1);
    const tteSec = Math.round(timeToExpiryMs / 1000);
    console.log(
      `[fairValueUpdater] LOW CONFIDENCE ${confidence.toFixed(2)} ` +
      `(obStale:${obStaleSec}s, tte:${tteSec}s) — skipping`
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
    publishedAt: now,
    ts: now,
  };

  await setFairValue(fv);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.fairValueUpdated(MARKET_ID), JSON.stringify(fv));

  console.log(
    `[fairValueUpdater] STRIKE FV=${(value * 100).toFixed(2)}% ` +
    `conf=${(confidence * 100).toFixed(0)}% ` +
    `btc=$${btcFeed.price.toFixed(2)} ` +
    `strike=$${STRIKE_PRICE.toFixed(2)} ` +
    `yesAsk=${(obFeed.bestAsk || 0).toFixed(4)} ` +
    `tte=${Math.round(timeToExpiryMs / 1000)}s`
  );
}

// ─── Market Rotation ─────────────────────────────────────────────────────────

let isProcessing = false;

async function rotateToMarket(
  sub: ReturnType<typeof getSubscriberClient>,
  info: ActiveMarketInfo
): Promise<void> {
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
  EXPIRY_TS = info.expiryTs;
  STRIKE_PRICE = info.strikePrice; // set by marketDiscovery from Chainlink history

  if (STRIKE_PRICE === null) {
    console.warn(
      '[fairValueUpdater] strike price is null — trading forbidden until next rotation ' +
      '(is chainlinkPriceFeeder running?)'
    );
  } else {
    console.log(`[fairValueUpdater] STRIKE_PRICE=$${STRIKE_PRICE.toFixed(2)} (from Chainlink)`);
  }

  await sub.subscribe(REDIS_CHANNELS.orderbookUpdated(MARKET_ID));

  console.log(
    `[fairValueUpdater] subscribed to orderbook for market ${MARKET_ID.slice(0, 10)}… ` +
    `expiry=${info.endDate}`
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
