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
 *   S = current Binance BTC/USDC price
 *   T = time-to-expiry in seconds
 *   σ = per-second EWMA volatility from Chainlink tick data
 *   σ5m/σ10m FV tracks blend coarse EWMA with Deribit mark IV when available
 *
 * Chainlink staleness guard:
 *   If the BTC feed is older than BTC_STALE_FORBID_MS, trading is hard-forbidden
 *   (early return). Confidence therefore only reflects time-to-expiry.
 *
 * Chainlink oracle lag (BTC_CHAINLINK_ORACLE_LAG_FORBID_MS):
 *   Chainlink pub/sub: if now - chainlinkTs exceeds limit, hard-forbid entire run.
 *   Orderbook: same lag skips appendMarketReportRow only so CSV rows stay aligned;
 *   fair value is still published for trading.
 */

import dotenv from 'dotenv';
import {
  BTC_CHAINLINK_ORACLE_LAG_FORBID_MS,
  BTC_STALE_FORBID_MS,
  MIN_CONFIDENCE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
  VERBOSE,
  VOLATILITY_EWMA_LAMBDA,
} from '../config/constants.js';
import { EWMAVolatility } from '../shared/ewmaVolatility.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import { computeBaseFairValue, computeFairValueConfidence, adjustedPerSecondVolatilityFromCoarseAndDeribit } from '../shared/fairValueMath.js';
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

/** Distinguishes Chainlink vs orderbook triggers for oracle-lag handling. */
type FairValueComputeTrigger = 'chainlink' | 'orderbook';

// ─── Mutable market state (updated on each market rotation) ───────────────────

let MARKET_ID: string | null = null;
let STRIKE_PRICE: number | null = null;
let EXPIRY_TS: number | null = null;
/** Deribit mark IV (annualized fraction) for the active window; from marketDiscovery. */
let DERIBIT_MARK_IV_ANNUAL: number | null = null;
let lastReportYesBid: number | null = null;
let lastReportYesAsk: number | null = null;
const volatilityEstimator = new EWMAVolatility({ lambda: VOLATILITY_EWMA_LAMBDA });
const volatilityEstimator5m = new EWMAVolatility({ lambda: VOLATILITY_EWMA_LAMBDA });
const volatilityEstimator10m = new EWMAVolatility({ lambda: VOLATILITY_EWMA_LAMBDA });
const ZERO_PRICE_ANOMALY_JUMP = 0.2;
const FIVE_MINUTES_MS = 5 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;

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

const chainlinkSampler5m = new CoarseChainlinkSampler(FIVE_MINUTES_MS);
const chainlinkSampler10m = new CoarseChainlinkSampler(TEN_MINUTES_MS);

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
  return sigma > 0 ? sigma : null;
}

function getCurrentSigmaFrom(estimator: EWMAVolatility): number | null {
  const sigma = estimator.getVolatility();
  return sigma > 0 ? sigma : null;
}

function perSecondVolatilityForCoarseFairValue(
  coarsePerSecond: number | null,
  deribitMarkIvAnnual: number | null,
): number | null {
  if (coarsePerSecond === null) return null;
  if (
    deribitMarkIvAnnual !== null &&
    deribitMarkIvAnnual > 0 &&
    Number.isFinite(deribitMarkIvAnnual)
  ) {
    return adjustedPerSecondVolatilityFromCoarseAndDeribit(coarsePerSecond, deribitMarkIvAnnual);
  }
  return coarsePerSecond;
}

async function warmVolatilityEstimator(): Promise<void> {
  const history = await getChainlinkBtcPriceHistory();
  if (history.length === 0) {
    console.log('[fairValueUpdater] no Chainlink history yet — EWMA sigma will warm from live ticks');
    return;
  }

  const sigma = volatilityEstimator.warmFromChainlinkHistory(history);
  for (const tick of [...history].sort((a, b) => a.chainlinkTs - b.chainlinkTs)) {
    const sampled5m = chainlinkSampler5m.update(tick.price, tick.chainlinkTs);
    if (sampled5m !== null) {
      const sampled5mTs = Math.floor(tick.chainlinkTs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
      volatilityEstimator5m.update(sampled5m, sampled5mTs);
    }
    const sampled10m = chainlinkSampler10m.update(tick.price, tick.chainlinkTs);
    if (sampled10m !== null) {
      const sampled10mTs = Math.floor(tick.chainlinkTs / TEN_MINUTES_MS) * TEN_MINUTES_MS;
      volatilityEstimator10m.update(sampled10m, sampled10mTs);
    }
  }
  const sigma5m = getCurrentSigmaFrom(volatilityEstimator5m);
  const sigma10m = getCurrentSigmaFrom(volatilityEstimator10m);
  console.log(
    `[fairValueUpdater] warmed EWMA sigma=${sigma.toExponential(3)} ` +
    `from ${history.length} Chainlink ticks ` +
    `(sigma5m=${sigma5m !== null ? sigma5m.toExponential(3) : 'n/a'}, ` +
    `sigma10m=${sigma10m !== null ? sigma10m.toExponential(3) : 'n/a'})`
  );
}

// ─── Core Computation ────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: ChainlinkBtcPriceFeed,
  obFeed: MarketOrderbookFeed,
  deribitMarkIvAnnual: number | null,
  trigger: FairValueComputeTrigger = 'orderbook'
): Promise<void> {
  if (!MARKET_ID) return;

  const now = Date.now();

  const binanceFeed = await getBtcPrice();
  if (!binanceFeed) {
    if (VERBOSE) console.log('[fairValueUpdater] no Binance BTC feed in Redis — forbidden');
    return;
  }

  // ── Hard-forbid on stale Binance BTC ──────────────────────────────────────
  const btcAgeMs = now - binanceFeed.ts;
  if (btcAgeMs > BTC_STALE_FORBID_MS) {
    console.log(
      `[fairValueUpdater] STALE BINANCE BTC (${(btcAgeMs / 1000).toFixed(1)}s > ` +
      `${BTC_STALE_FORBID_MS / 1000}s) — forbidden`
    );
    return;
  }

  // ── Oracle payload lag (Chainlink path: forbid run; orderbook: skip report below) ──
  if (trigger === 'chainlink') {
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
  if (sigmaPerSecond === null) return;

  const value = computeBaseFairValue({
    currentPrice: binanceFeed.price,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    perSecondVolatility: sigmaPerSecond,
  });
  const sigma5m = getCurrentSigmaFrom(volatilityEstimator5m);
  const sigma10m = getCurrentSigmaFrom(volatilityEstimator10m);
  // Do the sigma adjustment for #L add more than #S adds issue
  const sigma5mForFv = perSecondVolatilityForCoarseFairValue(sigma5m, deribitMarkIvAnnual);
  const sigma10mForFv = perSecondVolatilityForCoarseFairValue(sigma10m, deribitMarkIvAnnual);

  const fairValueSigma5m =
    sigma5m !== null
      ? computeBaseFairValue({
          currentPrice: binanceFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma5m,
        })
      : null;
  const fairValueSigma5mForFv =
    sigma5mForFv !== null
      ? computeBaseFairValue({
          currentPrice: binanceFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma5mForFv,
        })
      : null;
  const fairValueSigma10m =
    sigma10m !== null
      ? computeBaseFairValue({
          currentPrice: binanceFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma10m,
        })
      : null;
  const fairValueSigma10mForFv =
    sigma10mForFv !== null
      ? computeBaseFairValue({
          currentPrice: binanceFeed.price,
          strikePrice: STRIKE_PRICE,
          timeToExpiryMs,
          perSecondVolatility: sigma10mForFv,
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
    btcPrice: binanceFeed.price,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    publishedAt: now,
    ts: now,
  };

  const { yesBid, yesAsk } = sanitizeYesTopOfBook(obFeed.bestBid, obFeed.bestAsk);
  await setFairValue(fv);

  const reportOracleLagMs = Date.now() - btcFeed.chainlinkTs;
  const skipMarketReportForOracleLag =
    trigger === 'orderbook' && reportOracleLagMs > BTC_CHAINLINK_ORACLE_LAG_FORBID_MS;

  if (!skipMarketReportForOracleLag) {
    await appendMarketReportRow({
      marketId: MARKET_ID,
      fairValue: value,
      confidence,
      sigma: sigmaPerSecond,
      sigma5m,
      sigma10m,
      btcPrice: btcFeed.price,
      chainlinkTs: btcFeed.chainlinkTs,
      binanceBtcPrice: binanceFeed !== null ? binanceFeed.price : null,
      binanceTs: binanceFeed !== null ? binanceFeed.ts : null,
      binanceRedisTs: now,
      strikePrice: STRIKE_PRICE,
      timeToExpiryMs,
      yesBid,
      yesAsk,
      noBid: clampOutcomePrice(1 - yesAsk),
      noAsk: clampOutcomePrice(1 - yesBid),
      publishedAt: now,
      ts: now,
      fairValueSigma5m,
      fairValueSigma10m,
      fairValueSigma5mForFv,
      fairValueSigma10mForFv,
    });
  } else if (VERBOSE) {
    console.log(
      `[fairValueUpdater] skip appendMarketReportRow (orderbook): oracle lag ${reportOracleLagMs}ms > ` +
      `${BTC_CHAINLINK_ORACLE_LAG_FORBID_MS}ms`
    );
  }

  lastReportYesBid = yesBid;
  lastReportYesAsk = yesAsk;

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.fairValueUpdated(MARKET_ID), JSON.stringify(fv));

  // console.log(
  //   `[fairValueUpdater] STRIKE FV=${(value * 100).toFixed(2)}% ` +
  //   `conf=${(confidence * 100).toFixed(0)}% ` +
  //   `sigma=${sigmaPerSecond.toExponential(3)} ` +
  //   `sigma5m=${sigma5m !== null ? sigma5m.toExponential(3) : 'n/a'} ` +
  //   `sigma10m=${sigma10m !== null ? sigma10m.toExponential(3) : 'n/a'} ` +
  //   `chainlink=$${btcFeed.price.toFixed(2)} binance=$${binanceFeed.price.toFixed(2)} ` +
  //   `strike=$${STRIKE_PRICE.toFixed(2)} ` +
  //     `yesBid=${yesBid.toFixed(4)} yesAsk=${yesAsk.toFixed(4)} ` +
  //   `tte=${Math.round(timeToExpiryMs / 1000)}s`
  // );
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
  DERIBIT_MARK_IV_ANNUAL =
    typeof info.deribitMarkIvAnnual === 'number' &&
    Number.isFinite(info.deribitMarkIvAnnual) &&
    info.deribitMarkIvAnnual > 0
      ? info.deribitMarkIvAnnual
      : null;
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

  if (DERIBIT_MARK_IV_ANNUAL !== null) {
    console.log(
      `[fairValueUpdater] deribitMarkIv=${(DERIBIT_MARK_IV_ANNUAL * 100).toFixed(2)}%` +
      `${info.deribitInstrumentName ? ` (${info.deribitInstrumentName})` : ''}`
    );
  } else {
    console.warn('[fairValueUpdater] deribitMarkIv unavailable — sigma5m/10m FV use raw EWMA only');
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
            const sampled5m = chainlinkSampler5m.update(btcFeed.price, btcFeed.chainlinkTs);
            if (sampled5m !== null) {
              const sampled5mTs = Math.floor(btcFeed.chainlinkTs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
              volatilityEstimator5m.update(sampled5m, sampled5mTs);
            }
            const sampled10m = chainlinkSampler10m.update(btcFeed.price, btcFeed.chainlinkTs);
            if (sampled10m !== null) {
              const sampled10mTs = Math.floor(btcFeed.chainlinkTs / TEN_MINUTES_MS) * TEN_MINUTES_MS;
              volatilityEstimator10m.update(sampled10m, sampled10mTs);
            }
            const obFeed = await getOrderbook(MARKET_ID);
            if (!obFeed) return;
            await computeAndPublish(btcFeed, obFeed, DERIBIT_MARK_IV_ANNUAL, 'chainlink');
          } else if (channel === REDIS_CHANNELS.orderbookUpdated(MARKET_ID)) {
            const obFeed = JSON.parse(message) as MarketOrderbookFeed;
            const btcFeed = await getChainlinkBtcPrice();
            if (!btcFeed) return;
            await computeAndPublish(btcFeed, obFeed, DERIBIT_MARK_IV_ANNUAL, 'orderbook');
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
