/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger it computes the fair value (probability that "Yes"
 * resolves) and publishes to fv:updated:{conditionId}.
 *
 * Model: p_base-only binary option fair value.
 *   FV = clamp( N(d2), 0.01, 0.99 )
 *   d2 = [ln(S/K) - (σ^2 / 2) * T] / (σ × √T)
 *   K = strike price from marketDiscovery for the active 15-min window
 *   S = current Chainlink BTC/USD price
 *   T = time-to-expiry in seconds
 *   σ = per-second EWMA volatility from Chainlink tick data
 *
 * Chainlink staleness guard:
 *   If the BTC feed is older than BTC_STALE_FORBID_MS, trading is hard-forbidden
 *   (early return). Confidence therefore only reflects time-to-expiry.
 */

import dotenv from 'dotenv';
import {
  BTC_STALE_FORBID_MS,
  MIN_CONFIDENCE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
  VOLATILITY_EWMA_LAMBDA,
  VOLATILITY_MIN_TICKS,
} from '../config/constants.js';
import { EWMAVolatility } from '../shared/ewmaVolatility.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import { computeBaseFairValue, computeFairValueConfidence } from '../shared/fairValueMath.js';
import {
  getActiveMarket,
  getChainlinkBtcPrice,
  getChainlinkBtcPriceHistory,
  getOrderbook,
  setFairValue,
} from '../shared/state.js';
import {
  REDIS_CHANNELS,
  type ActiveMarketInfo,
  type ChainlinkBtcPriceFeed,
  type FairValue,
  type MarketOrderbookFeed,
} from '../shared/types.js';

dotenv.config();

// ─── Mutable market state (updated on each market rotation) ───────────────────

let MARKET_ID: string | null = null;
let STRIKE_PRICE: number | null = null;
let EXPIRY_TS: number | null = null;
const volatilityEstimator = new EWMAVolatility({
  lambda: VOLATILITY_EWMA_LAMBDA,
  minTicks: VOLATILITY_MIN_TICKS,
});
let sigmaNotReadyLogged = false;

function getCurrentSigmaPerSecond(): number | null {
  const sigma = volatilityEstimator.getVolatility();
  if (!volatilityEstimator.isReady() || sigma <= 0) {
    return null;
  }
  return sigma;
}

async function warmVolatilityEstimator(): Promise<void> {
  const history = await getChainlinkBtcPriceHistory();
  if (history.length === 0) {
    console.log('[fairValueUpdater] no Chainlink history yet — EWMA sigma will warm from live ticks');
    return;
  }

  const sigma = volatilityEstimator.warmFromChainlinkHistory(history);
  console.log(
    `[fairValueUpdater] warmed EWMA sigma=${sigma.toExponential(3)} ` +
    `from ${history.length} Chainlink ticks`
  );
}

// ─── Core Computation ────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: ChainlinkBtcPriceFeed,
  obFeed: MarketOrderbookFeed
): Promise<void> {
  if (!MARKET_ID) return;

  const now = Date.now();

  // ── Hard-forbid on stale Chainlink BTC ────────────────────────────────────
  const btcAgeMs = now - btcFeed.ts;
  if (btcAgeMs > BTC_STALE_FORBID_MS) {
    console.log(
      `[fairValueUpdater] STALE CHAINLINK BTC (${(btcAgeMs / 1000).toFixed(1)}s > ` +
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

  const sigmaPerSecond = getCurrentSigmaPerSecond();
  if (sigmaPerSecond === null) {
    if (!sigmaNotReadyLogged) {
      console.log(
        `[fairValueUpdater] EWMA sigma not ready yet ` +
        `(ticks=${volatilityEstimator.getTickCount()} < min=${VOLATILITY_MIN_TICKS})`
      );
      sigmaNotReadyLogged = true;
    }
    return;
  }
  sigmaNotReadyLogged = false;

  const value = computeBaseFairValue({
    currentPrice: btcFeed.price,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    perSecondVolatility: sigmaPerSecond,
  });
  const { confidence, timeBonus, atFloor } = computeFairValueConfidence(
    timeToExpiryMs,
    MIN_CONFIDENCE
  );

  if (confidence < MIN_CONFIDENCE) {
    const tteSec = Math.round(timeToExpiryMs / 1000);
    console.log(
      `[fairValueUpdater] LOW CONFIDENCE ${confidence.toFixed(2)} ` +
      `(tte:${tteSec}s) — skipping`
    );
    return;
  }

  if (atFloor) {
    const reasons: string[] = [];
    if (timeBonus < 0.5) {
      const tteSec = Math.round(timeToExpiryMs / 1000);
      reasons.push(`low tte (${tteSec}s, bonus=${(timeBonus * 100).toFixed(0)}%)`);
    }
    if (reasons.length === 0) reasons.push(`time bonus too low (tteBonus=${(timeBonus * 100).toFixed(0)}%)`);
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
    `sigma=${sigmaPerSecond.toExponential(3)} ` +
    `chainlink=$${btcFeed.price.toFixed(2)} ` +
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

  const chainlinkChannel = REDIS_CHANNELS.chainlinkBtcPriceUpdated;
  const discoveryChannel = REDIS_CHANNELS.newActiveMarket;

  await sub.subscribe(chainlinkChannel, discoveryChannel);
  console.log(`[fairValueUpdater] subscribed to ${chainlinkChannel} and ${discoveryChannel}`);
  await warmVolatilityEstimator();

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
          if (channel === chainlinkChannel) {
            const btcFeed = JSON.parse(message) as ChainlinkBtcPriceFeed;
            volatilityEstimator.update(btcFeed.price, btcFeed.chainlinkTs);
            const obFeed = await getOrderbook(MARKET_ID);
            if (!obFeed) return;
            await computeAndPublish(btcFeed, obFeed);
          } else if (channel === REDIS_CHANNELS.orderbookUpdated(MARKET_ID)) {
            const obFeed = JSON.parse(message) as MarketOrderbookFeed;
            const btcFeed = await getChainlinkBtcPrice();
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
