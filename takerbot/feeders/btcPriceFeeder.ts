/**
 * btcPriceFeeder
 *
 * Streams Binance BTC/USDC ticker via ccxt.pro watchTicker and publishes one
 * snapshot per second to Redis — mirroring the Chainlink feeder's cadence.
 *
 * watchTicker keeps an internal WebSocket connection and yields each pushed
 * update from Binance. We buffer the latest bid/ask and only publish when the
 * Unix second advances, so the log and Redis updates are clean 1-per-second
 * entries with no duplicates.
 *
 * Redis:
 *   SET  feed:btc:price                { price, bid, ask, ts }
 *   LIST feed:btc:price:history        rolling ~30m of snapshots (for pair stats)
 *   SET  feed:btc:ws:last-received-sec <unix_sec>              (liveness probe)
 *   PUB  btc:price:updated
 */

import dotenv from 'dotenv';
import ccxt from 'ccxt';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { appendBtcPriceHistory, setBtcPrice, setBtcWsLastReceivedSec } from '../shared/state.js';
import { REDIS_CHANNELS, type BtcPriceFeed } from '../shared/types.js';
dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL = 'BTC/USDC';
const RECONNECT_DELAY_MS = 5000;

// ─── State ────────────────────────────────────────────────────────────────────

// ccxt.pro namespace is runtime-attached to ccxt package.
const exchange = new (ccxt as any).pro.binance({
  enableRateLimit: true,
  options: {
    defaultType: 'spot',
  },
});

let isShuttingDown = false;

/** Unix second of the last published snapshot — throttle to 1 publish/sec. */
let lastPublishedSec = 0;
/** Latest bid/ask buffered from incoming ticks within the current second. */
let pendingBid = 0;
let pendingAsk = 0;

// ─── Message Handler ──────────────────────────────────────────────────────────

interface BinanceTicker {
  bid?: number;
  ask?: number;
  timestamp?: number;
  datetime?: string;
}

function getTickerTimestampMs(ticker: BinanceTicker): number | null {
  if (typeof ticker.timestamp === 'number' && Number.isFinite(ticker.timestamp) && ticker.timestamp > 0) {
    return ticker.timestamp;
  }
  if (typeof ticker.datetime === 'string') {
    const parsed = Date.parse(ticker.datetime);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

let lastPublishedBid = 0;
let lastPublishedAsk = 0;
let lastPublishedSourceTickMs = 0;

async function handleTicker(ticker: BinanceTicker): Promise<void> {
  const localNowSec = Math.floor(Date.now() / 1000);

  // Liveness probe — stamp every frame so the TTL key never goes stale mid-second
  await setBtcWsLastReceivedSec(localNowSec);

  const bid = ticker.bid;
  const ask = ticker.ask;
  if (typeof bid !== 'number' || typeof ask !== 'number') return;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;

  const sourceTickMs = getTickerTimestampMs(ticker) ?? Date.now();
  const sourceSec = Math.floor(sourceTickMs / 1000);

  // Always buffer the latest tick within this second
  pendingBid = bid;
  pendingAsk = ask;

  // Publish at most once per second — same cadence as chainlinkPriceFeeder
  if (sourceSec <= lastPublishedSec) return;
  lastPublishedSec = sourceSec;

  // Guard against stale/cached ticks being replayed across local wall-clock seconds.
  if (sourceTickMs <= lastPublishedSourceTickMs && pendingBid === lastPublishedBid && pendingAsk === lastPublishedAsk) return;

  const price = (pendingBid + pendingAsk) / 2;
  const feed: BtcPriceFeed = { price, bid: pendingBid, ask: pendingAsk, ts: sourceTickMs };

  await setBtcPrice(feed);
  await appendBtcPriceHistory(feed);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.btcPriceUpdated, JSON.stringify(feed));
  lastPublishedSourceTickMs = sourceTickMs;
  lastPublishedBid = pendingBid;
  lastPublishedAsk = pendingAsk;

  // console.log(
  //   `[btcPriceFeeder] BTC/USD $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
  //   `bid=${pendingBid.toFixed(2)} ask=${pendingAsk.toFixed(2)} (ws_ms: ${Math.floor(feed.ts / 1000) * 1000})`
  // );
}

async function start(): Promise<void> {
  console.log(`[btcPriceFeeder] connecting to Binance via ccxt.pro for ${SYMBOL}...`);

  while (!isShuttingDown) {
    try {
      const ticker = (await exchange.watchTicker(SYMBOL)) as BinanceTicker;
      await handleTicker(ticker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isShuttingDown) break;
      console.error(`[btcPriceFeeder] connection error: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[btcPriceFeeder] shutting down…');
  await exchange.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Start ────────────────────────────────────────────────────────────────────

start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[btcPriceFeeder] fatal error:', message);
  process.exit(1);
});