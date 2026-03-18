/**
 * fairValueUpdater
 *
 * Subscribes to Redis channels for BTC price updates and market orderbook
 * updates. On each trigger, computes the fair value (probability) of "Yes"
 * resolving and writes it to Redis, publishing to fv:updated:{marketId}.
 *
 * Fair Value Model (simplified linear):
 *   For "above $K" markets:
 *     FV = clamp(0.5 + (S - K) / K × FV_SCALE, 0.05, 0.95)
 *     S = current BTC price, K = strike price
 *
 *   For "up/down" markets (no strike): FV = 0.5
 *
 * Run as a standalone process via PM2 (one per market).
 *
 *   tsx takerbot/updater/fairValueUpdater.ts --marketid=<id>
 */

import dotenv from 'dotenv';
import { FV_SCALE, MIN_CONFIDENCE, STOP_TRADING_BEFORE_EXPIRY_MS } from '../config/constants.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import { getBtcPrice, getOrderbook, setFairValue } from '../shared/state.js';
import {
  REDIS_CHANNELS,
  type BtcPriceFeed,
  type FairValue,
  type MarketOrderbookFeed,
} from '../shared/types.js';

dotenv.config();

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg?.slice(flag.length);
}

const MARKET_ID = getArg('marketid') ?? process.env['MARKET_ID'];
const STRIKE_PRICE = getArg('strike')
  ? Number(getArg('strike'))
  : process.env['STRIKE_PRICE']
  ? Number(process.env['STRIKE_PRICE'])
  : null;
const EXPIRY_TS = getArg('expiry')
  ? Number(getArg('expiry'))
  : process.env['EXPIRY_TS']
  ? Number(process.env['EXPIRY_TS'])
  : null;

if (!MARKET_ID) {
  console.error('[fairValueUpdater] Usage: tsx fairValueUpdater.ts --marketid=<id> [--strike=<usd>] [--expiry=<epochMs>]');
  process.exit(1);
}

// ─── Fair value math ──────────────────────────────────────────────────────────

/**
 * Simplified linear fair value for "BTC above $K?" markets.
 *
 *   FV = clamp(0.5 + (S - K) / K × FV_SCALE, 0.05, 0.95)
 *
 * @param currentPrice  Current BTC mid price (USD)
 * @param strikePrice   Strike price K (USD)
 * @returns Probability in [0.05, 0.95]
 */
function computeFairValue(currentPrice: number, strikePrice: number): number {
  const relativeDistance = (currentPrice - strikePrice) / strikePrice;
  return Math.min(0.95, Math.max(0.05, 0.5 + relativeDistance * FV_SCALE));
}

/**
 * Confidence degrades as:
 *  - Data freshness decreases (stale BTC price or stale orderbook)
 *  - Time to expiry shrinks below 1 minute (the model breaks down)
 */
function computeConfidence(
  btcTs: number,
  obTs: number,
  timeToExpiryMs: number
): number {
  const now = Date.now();
  const btcStaleness = Math.max(0, 1 - (now - btcTs) / 5000);  // 0 at 5s stale
  const obStaleness = Math.max(0, 1 - (now - obTs) / 5000);
  // Ramp down confidence over the window leading up to the trading stop.
  // Trading halts at STOP_TRADING_BEFORE_EXPIRY_MS (90s); start degrading at 3× that window
  // so the confidence signal is meaningful before the strategy gate kicks in.
  const timeBonus = Math.min(1, timeToExpiryMs / (STOP_TRADING_BEFORE_EXPIRY_MS * 2));
  return Math.min(btcStaleness, obStaleness) * timeBonus;
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function computeAndPublish(
  btcFeed: BtcPriceFeed,
  _obFeed: MarketOrderbookFeed
): Promise<void> {
  const now = Date.now();
  const expiryMs = EXPIRY_TS ?? now + 15 * 60 * 1000;
  const timeToExpiryMs = expiryMs - now;

  let value: number;

  if (STRIKE_PRICE !== null && STRIKE_PRICE > 0) {
    value = computeFairValue(btcFeed.price, STRIKE_PRICE);
  } else {
    // "Up or Down" market — no directional model yet
    value = 0.5;
  }

  const confidence = computeConfidence(btcFeed.ts, _obFeed.ts, timeToExpiryMs);

  if (confidence < MIN_CONFIDENCE) {
    console.warn(
      `[fairValueUpdater] low confidence (${confidence.toFixed(2)}), skipping publish`
    );
    return;
  }

  const fv: FairValue = {
    marketId: MARKET_ID!,
    value,
    confidence,
    btcPrice: btcFeed.price,
    strikePrice: STRIKE_PRICE,
    timeToExpiryMs,
    ts: now,
  };

  await setFairValue(fv);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.fairValueUpdated(MARKET_ID!), JSON.stringify(fv));

  console.log(
    `[fairValueUpdater] FV=${(value * 100).toFixed(2)}% ` +
    `conf=${(confidence * 100).toFixed(0)}% ` +
    `btc=$${btcFeed.price.toFixed(2)} ` +
    `tte=${Math.round(timeToExpiryMs / 1000)}s`
  );
}

// ─── Redis subscription ───────────────────────────────────────────────────────

let isProcessing = false;

async function start(): Promise<void> {
  const sub = getSubscriberClient();

  const btcChannel = REDIS_CHANNELS.btcPriceUpdated;
  const obChannel = REDIS_CHANNELS.orderbookUpdated(MARKET_ID!);

  await sub.subscribe(btcChannel, obChannel);
  console.log(`[fairValueUpdater] subscribed to ${btcChannel} + ${obChannel}`);

  sub.on('message', (channel, message) => {
    if (isProcessing) return;
    isProcessing = true;

    void (async () => {
      try {
        if (channel === btcChannel) {
          const btcFeed = JSON.parse(message) as BtcPriceFeed;
          const obFeed = await getOrderbook(MARKET_ID!);
          if (!obFeed) return;
          await computeAndPublish(btcFeed, obFeed);
        } else if (channel === obChannel) {
          const obFeed = JSON.parse(message) as MarketOrderbookFeed;
          const btcFeed = await getBtcPrice();
          if (!btcFeed) return;
          await computeAndPublish(btcFeed, obFeed);
        }
      } catch (err) {
        console.error('[fairValueUpdater] error:', err);
      } finally {
        isProcessing = false;
      }
    })();
  });
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[fairValueUpdater] shutting down…');
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Start ────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[fairValueUpdater] fatal:', err);
  process.exit(1);
});
