/**
 * btcPriceFeeder
 *
 * Streams Binance BTCUSDC best bid/ask via bookTicker WebSocket and publishes
 * one snapshot per second to Redis — mirroring the Chainlink feeder's cadence.
 *
 * Binance fires bookTicker on every tick (many times per second).  We buffer
 * the latest bid/ask and only publish when the Unix second advances, so the
 * log and Redis updates are clean 1-per-second entries with no duplicates.
 *
 * Redis:
 *   SET  feed:btc:price                { price, bid, ask, ts }
 *   LIST feed:btc:price:history        rolling ~30m of snapshots (for pair stats)
 *   SET  feed:btc:ws:last-received-sec <unix_sec>              (liveness probe)
 *   PUB  btc:price:updated
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { appendBtcPriceHistory, setBtcPrice, setBtcWsLastReceivedSec } from '../shared/state.js';
import { REDIS_CHANNELS, type BtcPriceFeed } from '../shared/types.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdc@bookTicker';
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_BACKOFF_BASE = 3000;
const MAX_RECONNECT_BACKOFF = 60_000;
const FORCE_RECONNECT_AFTER_MS = 23 * 60 * 60 * 1000; // 23 hours

// ─── State ────────────────────────────────────────────────────────────────────

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let lastConnectTime = 0;

/** Unix second of the last published snapshot — throttle to 1 publish/sec. */
let lastPublishedSec = 0;
/** Latest bid/ask buffered from incoming ticks within the current second. */
let pendingBid = 0;
let pendingAsk = 0;

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect(): void {
  console.log('[btcPriceFeeder] connecting to Binance WS…');

  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
  }

  ws = new WebSocket(BINANCE_WS_URL);
  lastConnectTime = Date.now();
  reconnectAttempts = 0;

  ws.on('open', () => {
    console.log('[btcPriceFeeder] connected successfully');
    reconnectAttempts = 0;
  });

  ws.on('ping', (data) => {
    ws?.pong(data);
  });

  ws.on('message', (raw) => {
    void handleMessage(raw.toString());
  });

  ws.on('error', (err) => {
    console.error('[btcPriceFeeder] WS error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.warn(`[btcPriceFeeder] disconnected (code: ${code}) — reason: ${reason || 'none'}`);
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const backoff = Math.min(RECONNECT_BACKOFF_BASE * Math.pow(2, reconnectAttempts), MAX_RECONNECT_BACKOFF);
  console.log(`[btcPriceFeeder] reconnecting in ${backoff / 1000}s (attempt ${reconnectAttempts + 1})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[btcPriceFeeder] max reconnect attempts reached, exiting');
      process.exit(1);
    }
    connect();
  }, backoff);
}

// Force reconnect every 30 min to guard against Binance's 24 h connection limit
setInterval(() => {
  if (ws && Date.now() - lastConnectTime > FORCE_RECONNECT_AFTER_MS) {
    console.log('[btcPriceFeeder] forcing reconnect due to 24h limit');
    ws.close();
  }
}, 30 * 60 * 1000);

// ─── Message Handler ──────────────────────────────────────────────────────────

interface BinanceBookTicker {
  u: number;
  s: string;
  b: string; // best bid price
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
}

async function handleMessage(raw: string): Promise<void> {
  const currentSec = Math.floor(Date.now() / 1000);

  // Liveness probe — stamp every frame so the TTL key never goes stale mid-second
  await setBtcWsLastReceivedSec(currentSec);

  let msg: BinanceBookTicker;
  try {
    msg = JSON.parse(raw) as BinanceBookTicker;
  } catch {
    return;
  }

  const bid = Number.parseFloat(msg.b);
  const ask = Number.parseFloat(msg.a);
  if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;

  // Always buffer the latest tick within this second
  pendingBid = bid;
  pendingAsk = ask;

  // Publish at most once per second — same cadence as chainlinkPriceFeeder
  if (currentSec <= lastPublishedSec) return;
  lastPublishedSec = currentSec;

  const price = (pendingBid + pendingAsk) / 2;
  const feed: BtcPriceFeed = { price, bid: pendingBid, ask: pendingAsk, ts: Date.now() };

  await setBtcPrice(feed);
  await appendBtcPriceHistory(feed);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.btcPriceUpdated, JSON.stringify(feed));

  console.log(
    `[btcPriceFeeder] BTC/USD $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
    `bid=${pendingBid.toFixed(2)} ask=${pendingAsk.toFixed(2)} (ws_ms: ${Math.floor(feed.ts / 1000) * 1000})`
  );
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[btcPriceFeeder] shutting down…');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Start ────────────────────────────────────────────────────────────────────

connect();