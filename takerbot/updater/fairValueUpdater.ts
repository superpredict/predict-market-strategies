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
 *
 * Chainlink oracle lag guard (Chainlink pub/sub path only):
 *   If now - chainlinkTs exceeds BTC_CHAINLINK_ORACLE_LAG_FORBID_MS, hard-forbid.
 *   Skipped on orderbook-triggered runs so frequent book updates are not blocked.
 */

import dotenv from 'dotenv';
import {
  BTC_CHAINLINK_ORACLE_LAG_FORBID_MS,
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
  appendMarketReportRow,
  getActiveMarket,
  getBtcPrice,
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
let lastReportYesBid: number | null = null;
let lastReportYesAsk: number | null = null;
const volatilityEstimator = new EWMAVolatility({
  lambda: VOLATILITY_EWMA_LAMBDA,
  minTicks: VOLATILITY_MIN_TICKS,
});
const volatilityEstimator1m = new EWMAVolatility({
  lambda: VOLATILITY_EWMA_LAMBDA,
  minTicks: VOLATILITY_MIN_TICKS,
});
const volatilityEstimator5m = new EWMAVolatility({
  lambda: VOLATILITY_EWMA_LAMBDA,
  minTicks: VOLATILITY_MIN_TICKS,
});
let sigmaNotReadyLogged = false;
const ZERO_PRICE_ANOMALY_JUMP = 0.2;
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

class CoarseChainlinkSampler {
  private readonly intervalMs: number;
  private currentBucketStartMs: number | null = null;
  private lastPriceInBucket: number | null = null;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  update(price: number, timestampMs: number): number | null {
    const bucketStart = Math.floor(timestampMs / this.intervalMs) * this.intervalMs;
    if (this.currentBucketStartMs === null) {
      this.currentBucketStartMs = bucketStart;
      this.lastPriceInBucket = price;
      return null;
    }

    if (bucketStart === this.currentBucketStartMs) {
      this.lastPriceInBucket = price;
      return null;
    }

    const sampledPrice = this.lastPriceInBucket;
    this.currentBucketStartMs = bucketStart;
    this.lastPriceInBucket = price;
    if (sampledPrice === null) return null;
    return sampledPrice;
  }
}

const chainlinkSampler1m = new CoarseChainlinkSampler(ONE_MINUTE_MS);
const chainlinkSampler5m = new CoarseChainlinkSampler(FIVE_MINUTES_MS);

function clampOutcomePrice(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sanitizeYesTopOfBook(yesBid: number, yesAsk: number): { yesBid: number; yesAsk: number } {
  let bid = yesBid;
  let ask = yesAsk;

  const askCollapsedToZero =
    ask === 0 &&
    lastReportYesAsk !== null &&
    lastReportYesAsk > 0 &&
    Math.abs(lastReportYesAsk - ask) >= ZERO_PRICE_ANOMALY_JUMP &&
    bid > 0;
  if (askCollapsedToZero) {
    const prevAsk = lastReportYesAsk!;
    ask = bid;
    console.warn(
      `[fairValueUpdater] corrected anomalous yesAsk 0.0000 -> ${ask.toFixed(4)} ` +
      `(prevAsk=${prevAsk.toFixed(4)}, bid=${bid.toFixed(4)})`
    );
  }

  const bidCollapsedToZero =
    bid === 0 &&
    lastReportYesBid !== null &&
    lastReportYesBid > 0 &&
    Math.abs(lastReportYesBid - bid) >= ZERO_PRICE_ANOMALY_JUMP &&
    ask > 0;
  if (bidCollapsedToZero) {
    const prevBid = lastReportYesBid!;
    bid = ask;
    console.warn(
      `[fairValueUpdater] corrected anomalous yesBid 0.0000 -> ${bid.toFixed(4)} ` +
      `(prevBid=${prevBid.toFixed(4)}, ask=${ask.toFixed(4)})`
    );
  }

  return { yesBid: bid, yesAsk: ask };
}

function getCurrentSigmaPerSecond(): number | null {
  const sigma = volatilityEstimator.getVolatility();
  if (!volatilityEstimator.isReady() || sigma <= 0) {
    return null;
  }
  return sigma;
}

function getCurrentSigmaFrom(estimator: EWMAVolatility): number | null {
  const sigma = estimator.getVolatility();
  if (!estimator.isReady() || sigma <= 0) return null;
  return sigma;
}

async function warmVolatilityEstimator(): Promise<void> {
  const history = await getChainlinkBtcPriceHistory();
  if (history.length === 0) {
    console.log('[fairValueUpdater] no Chainlink history yet — EWMA sigma will warm from live ticks');
    return;
  }

  const sigma = volatilityEstimator.warmFromChainlinkHistory(history);
  for (const tick of [...history].sort((a, b) => a.chainlinkTs - b.chainlinkTs)) {
    const sampled1m = chainlinkSampler1m.update(tick.price, tick.chainlinkTs);
    if (sampled1m !== null) {
      const sampled1mTs = Math.floor(tick.chainlinkTs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
      volatilityEstimator1m.update(sampled1m, sampled1mTs);
    }
    const sampled5m = chainlinkSampler5m.update(tick.price, tick.chainlinkTs);
    if (sampled5m !== null) {
      const sampled5mTs = Math.floor(tick.chainlinkTs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
      volatilityEstimator5m.update(sampled5m, sampled5mTs);
    }
  }
  const sigma1m = getCurrentSigmaFrom(volatilityEstimator1m);
  const sigma5m = getCurrentSigmaFrom(volatilityEstimator5m);
  console.log(
    `[fairValueUpdater] warmed EWMA sigma=${sigma.toExponential(3)} ` +
    `from ${history.length} Chainlink ticks ` +
    `(sigma1m=${sigma1m !== null ? sigma1m.toExponential(3) : 'n/a'}, ` +
    `sigma5m=${sigma5m !== null ? sigma5m.toExponential(3) : 'n/a'})`
  );
}

// ─── Core Computation ────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: ChainlinkBtcPriceFeed,
  obFeed: MarketOrderbookFeed,
  enforceChainlinkOracleLagForbid = false
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

  // ── Oracle payload lag (Chainlink pub/sub path only) ───────────────────────
  if (enforceChainlinkOracleLagForbid) {
    const oracleLagMs = now - btcFeed.chainlinkTs;
    if (oracleLagMs > BTC_CHAINLINK_ORACLE_LAG_FORBID_MS) {
      console.log(
        `[fairValueUpdater] CHAINLINK ORACLE LAG (${oracleLagMs}ms > ` +
        `${BTC_CHAINLINK_ORACLE_LAG_FORBID_MS}ms, now−chainlinkTs) — forbidden`
      );
      return;
    }
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
  const sigma1m = getCurrentSigmaFrom(volatilityEstimator1m);
  const sigma5m = getCurrentSigmaFrom(volatilityEstimator5m);
  const fairValueSigma1m =
    sigma1m !== null
      ? computeBaseFairValue({
          currentPrice: btcFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma1m,
        })
      : null;
  const fairValueSigma5m =
    sigma5m !== null
      ? computeBaseFairValue({
          currentPrice: btcFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma5m,
        })
      : null;
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

  const { yesBid, yesAsk } = sanitizeYesTopOfBook(obFeed.bestBid, obFeed.bestAsk);
  await setFairValue(fv);
  const binanceFeed = await getBtcPrice();
  await appendMarketReportRow({
    marketId: MARKET_ID,
    fairValue: value,
    confidence,
    sigma: sigmaPerSecond,
    sigma1m,
    sigma5m,
    btcPrice: btcFeed.price,
    chainlinkTs: btcFeed.chainlinkTs,
    binanceBtcPrice: binanceFeed !== null ? binanceFeed.price : null,
    binanceTs: binanceFeed !== null ? binanceFeed.ts : null,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    yesBid,
    yesAsk,
    noBid: clampOutcomePrice(1 - yesAsk),
    noAsk: clampOutcomePrice(1 - yesBid),
    publishedAt: now,
    ts: now,
    fairValueSigma1m,
    fairValueSigma5m,
  });
  lastReportYesBid = yesBid;
  lastReportYesAsk = yesAsk;

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.fairValueUpdated(MARKET_ID), JSON.stringify(fv));

  console.log(
    `[fairValueUpdater] STRIKE FV=${(value * 100).toFixed(2)}% ` +
    `conf=${(confidence * 100).toFixed(0)}% ` +
    `sigma=${sigmaPerSecond.toExponential(3)} ` +
    `sigma1m=${sigma1m !== null ? sigma1m.toExponential(3) : 'n/a'} ` +
    `sigma5m=${sigma5m !== null ? sigma5m.toExponential(3) : 'n/a'} ` +
    `chainlink=$${btcFeed.price.toFixed(2)} ` +
    `strike=$${STRIKE_PRICE.toFixed(2)} ` +
      `yesBid=${yesBid.toFixed(4)} yesAsk=${yesAsk.toFixed(4)} ` +
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
  lastReportYesBid = null;
  lastReportYesAsk = null;

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
            const sampled1m = chainlinkSampler1m.update(btcFeed.price, btcFeed.chainlinkTs);
            if (sampled1m !== null) {
              const sampled1mTs = Math.floor(btcFeed.chainlinkTs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
              volatilityEstimator1m.update(sampled1m, sampled1mTs);
            }
            const sampled5m = chainlinkSampler5m.update(btcFeed.price, btcFeed.chainlinkTs);
            if (sampled5m !== null) {
              const sampled5mTs = Math.floor(btcFeed.chainlinkTs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
              volatilityEstimator5m.update(sampled5m, sampled5mTs);
            }
            const obFeed = await getOrderbook(MARKET_ID);
            if (!obFeed) return;
            await computeAndPublish(btcFeed, obFeed, true);
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
