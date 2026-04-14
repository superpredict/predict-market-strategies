/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger it computes the fair value (probability that "Yes"
 * resolves) and publishes to fv:updated:{conditionId}.
 *
 * Model: binary-option (cash-or-nothing) with time decay.
 *   FV = clamp( N( ln(S/K) / (σ × √T) ), 0.01, 0.99 )
 *   K = strike price from marketDiscovery for the active 15-min window
 *   S = current Binance BTC mid price
 *   T = time-to-expiry in years
 *   σ = BTC_SIGMA_ANNUAL (annualised volatility)
 *
 * BTC staleness guard:
 *   If the BTC feed is older than BTC_STALE_FORBID_MS, trading is hard-forbidden
 *   (early return). Confidence therefore only reflects orderbook freshness and
 *   time-to-expiry.
 */

import dotenv from 'dotenv';
import {
  BTC_SIGMA_ANNUAL,
  BTC_STALE_FORBID_MS,
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
 * Standard-normal CDF via Abramowitz & Stegun polynomial (max error < 7.5e-8).
 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-(x * x) / 2);
  const poly = t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  const p = 1 - d * poly;
  return x >= 0 ? p : 1 - p;
}

/**
 * Binary-option (cash-or-nothing) fair value with time decay.
 *
 *   FV = clamp( N( ln(S/K) / (σ × √T) ), 0.01, 0.99 )
 *
 * Correctly converges to ~0 or ~1 as T → 0, matching market prices near expiry.
 */
function computeStrikeFairValue(
  currentPrice: number,
  strikePrice: number,
  timeToExpiryMs: number
): number {
  const T = timeToExpiryMs / 1000 / 31_536_000; // ms → years
  const sigmaT = BTC_SIGMA_ANNUAL * Math.sqrt(T);

  if (sigmaT < 1e-9) {
    return currentPrice >= strikePrice ? 0.99 : 0.01;
  }

  const d = Math.log(currentPrice / strikePrice) / sigmaT;
  return Math.min(0.99, Math.max(0.01, normalCDF(d)));
}

interface ConfidenceResult {
  confidence: number;
  obStaleness: number;
  timeBonus: number;
  atFloor: boolean;
}

/**
 * Confidence score based on orderbook freshness and time-to-expiry.
 * BTC staleness is handled upstream via a hard forbid, not here.
 */
function computeConfidence(obTs: number, timeToExpiryMs: number): ConfidenceResult {
  const now = Date.now();
  const obStaleness = Math.max(0, 1 - (now - obTs) / 20_000); // 20 s window
  const timeBonus = Math.min(1, timeToExpiryMs / 1_000_000); // floor at MIN_CONFIDENCE when tte ≈ 3 min
  const rawScore = obStaleness * timeBonus;
  const confidence = Math.max(MIN_CONFIDENCE, rawScore);
  return { confidence, obStaleness, timeBonus, atFloor: rawScore < MIN_CONFIDENCE };
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
    console.log('[fairValueUpdater] no strike price — forbidden (marketDiscovery has no Vatic target yet)');
    return;
  }

  const expiryMs = EXPIRY_TS ?? now + 15 * 60 * 1000;
  const timeToExpiryMs = expiryMs - now;

  if (timeToExpiryMs < STOP_TRADING_BEFORE_EXPIRY_MS) return;

  const value = computeStrikeFairValue(btcFeed.price, STRIKE_PRICE, timeToExpiryMs);
  const { confidence, obStaleness, timeBonus, atFloor } = computeConfidence(obFeed.ts, timeToExpiryMs);

  if (confidence < MIN_CONFIDENCE) {
    const obStaleSec = ((now - obFeed.ts) / 1000).toFixed(1);
    const tteSec = Math.round(timeToExpiryMs / 1000);
    console.log(
      `[fairValueUpdater] LOW CONFIDENCE ${confidence.toFixed(2)} ` +
      `(obStale:${obStaleSec}s, tte:${tteSec}s) — skipping`
    );
    return;
  }

  if (atFloor) {
    const reasons: string[] = [];
    if (obStaleness < 0.5) {
      const obAgeSec = ((now - obFeed.ts) / 1000).toFixed(1);
      reasons.push(`ob stale (age=${obAgeSec}s, staleness=${(obStaleness * 100).toFixed(0)}%)`);
    }
    if (timeBonus < 0.5) {
      const tteSec = Math.round(timeToExpiryMs / 1000);
      reasons.push(`low tte (${tteSec}s, bonus=${(timeBonus * 100).toFixed(0)}%)`);
    }
    if (reasons.length === 0) reasons.push(`combined score too low (ob=${(obStaleness * 100).toFixed(0)}%, tte=${(timeBonus * 100).toFixed(0)}%)`);
    console.log(`[fairValueUpdater] conf=MIN_CONFIDENCE(${MIN_CONFIDENCE}) — ${reasons.join(' | ')}`);
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
  STRIKE_PRICE = info.strikePrice; // set by marketDiscovery from Vatic active target

  if (STRIKE_PRICE === null) {
    console.warn(
      '[fairValueUpdater] strike price is null — trading forbidden until next rotation ' +
      '(Vatic target unavailable)'
    );
  } else {
    console.log(`[fairValueUpdater] STRIKE_PRICE=$${STRIKE_PRICE.toFixed(2)} (from Vatic target)`);
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
