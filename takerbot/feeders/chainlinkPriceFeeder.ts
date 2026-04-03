/**
 * chainlinkPriceFeeder
 *
 * Connects to Polymarket's live-data WebSocket and subscribes to the
 * crypto_prices_chainlink topic, filtering for BTC/USD.
 *
 * The Chainlink BTC/USD price is what Polymarket uses as the strike price
 * when a new 15-minute BTC market opens.  fairValueUpdater reads the latest
 * snapshot from Redis on each market rotation to set STRIKE_PRICE.
 *
 * Redis:
 *   SET  feed:chainlink:btc:price  { price, ts, chainlinkTs }
 *   PUB  chainlink:btc:price:updated
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { appendChainlinkPriceHistory, setChainlinkBtcPrice } from '../shared/state.js';
import { REDIS_CHANNELS, type ChainlinkBtcPriceFeed } from '../shared/types.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const POLYMARKET_WS_URL = 'wss://ws-live-data.polymarket.com';
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_BACKOFF_BASE = 3000;
const MAX_RECONNECT_BACKOFF = 60_000;

const SUBSCRIBE_MSG = {
  action: 'subscribe',
  subscriptions: [
    { topic: 'crypto_prices_chainlink', type: '*', filters: '' },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect(): void {
  console.log('[chainlinkPriceFeeder] connecting to Polymarket WS…');

  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
  }

  ws = new WebSocket(POLYMARKET_WS_URL);

  ws.on('open', () => {
    console.log('[chainlinkPriceFeeder] connected, subscribing to crypto_prices_chainlink…');
    reconnectAttempts = 0;
    ws!.send(JSON.stringify(SUBSCRIBE_MSG));
  });

  ws.on('ping', (data) => {
    ws?.pong(data);
  });

  ws.on('message', (raw) => {
    void handleMessage(raw.toString());
  });

  ws.on('error', (err) => {
    console.error('[chainlinkPriceFeeder] WS error:', err.message);
  });

  ws.on('close', (code) => {
    console.warn(`[chainlinkPriceFeeder] disconnected (code: ${code}), will reconnect…`);
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const backoff = Math.min(
    RECONNECT_BACKOFF_BASE * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_BACKOFF
  );

  console.log(
    `[chainlinkPriceFeeder] reconnecting in ${backoff / 1000}s (attempt ${reconnectAttempts + 1})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[chainlinkPriceFeeder] max reconnect attempts reached, exiting');
      process.exit(1);
    }

    connect();
  }, backoff);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

interface PolymarketChainlinkMsg {
  topic: string;
  type: string;
  payload?: {
    symbol: string;
    value: string;
    timestamp: string; // ISO-8601
  };
}

async function handleMessage(raw: string): Promise<void> {
  let msg: PolymarketChainlinkMsg;
  try {
    msg = JSON.parse(raw) as PolymarketChainlinkMsg;
  } catch {
    return;
  }

  if (
    msg.topic !== 'crypto_prices_chainlink' ||
    msg.type !== 'update' ||
    !msg.payload ||
    msg.payload.symbol !== 'btc/usd'
  ) {
    return;
  }

  const price = parseFloat(msg.payload.value);
  if (isNaN(price) || price <= 0) return;

  const chainlinkTs = new Date(msg.payload.timestamp).getTime();
  const chainlinkTsSec = Math.floor(chainlinkTs / 1000);
  const isBoundary = chainlinkTsSec % 900 === 0;

  const feed: ChainlinkBtcPriceFeed = { price, ts: Date.now(), chainlinkTs };

  // Always write to latest key and history — every second is stored so that
  // the exact 15-min boundary entry (chainlinkTs/1000 % 900 === 0) is never missed.
  await setChainlinkBtcPrice(feed);
  await appendChainlinkPriceHistory(feed);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.chainlinkBtcPriceUpdated, JSON.stringify(feed));

  const boundaryTag = isBoundary ? ' ★ 15-MIN BOUNDARY (STRIKE PRICE)' : '';
  console.log(
    `[chainlinkPriceFeeder] Chainlink BTC/USD $${price.toLocaleString()} ` +
    `(chainlink ts: ${msg.payload.timestamp})${boundaryTag}`
  );
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[chainlinkPriceFeeder] shutting down…');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Start ────────────────────────────────────────────────────────────────────

connect();
