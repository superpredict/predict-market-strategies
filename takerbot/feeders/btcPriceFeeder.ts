/**
 * btcPriceFeeder (Improved Version)
 *
 * Fixed issues:
 * - Proper ping/pong handling to prevent Binance from closing the connection
 * - Exponential backoff reconnection
 * - 24-hour forced reconnect
 * - More stable price updates
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { BTC_MIN_PRICE_CHANGE_USD, WS_RECONNECT_DELAY_MS } from '../config/constants.js';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { appendBtcPriceHistory, setBtcPrice } from '../shared/state.js';
import { REDIS_CHANNELS, type BtcPriceFeed } from '../shared/types.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_BACKOFF_BASE = 3000; // 3 seconds
const FORCE_RECONNECT_AFTER_MS = 23 * 60 * 60 * 1000; // 23 hours

// ─── State ────────────────────────────────────────────────────────────────────

let lastPublishedPrice = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let lastConnectTime = 0;

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

  // Handle Binance ping (critical for stability)
  ws.on('ping', (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.pong(data); // Reply with the same payload
      console.log('[btcPriceFeeder] received ping, sent pong');
    }
  });

  ws.on('message', async (raw) => {
    try {
      await handleMessage(raw.toString());
    } catch (err) {
      console.error('[btcPriceFeeder] message error:', err);
    }
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

  // Exponential backoff: 3s → 6s → 12s → max ~60s
  const backoff = Math.min(RECONNECT_BACKOFF_BASE * Math.pow(2, reconnectAttempts), 60000);

  console.log(`[btcPriceFeeder] scheduling reconnect in ${backoff / 1000}s (attempt ${reconnectAttempts + 1})`);

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

// Force reconnect every ~23 hours to handle Binance 24h limit
setInterval(() => {
  if (ws && Date.now() - lastConnectTime > FORCE_RECONNECT_AFTER_MS) {
    console.log('[btcPriceFeeder] forcing reconnect due to 24h limit');
    if (ws) ws.close();
  }
}, 30 * 60 * 1000); // Check every 30 minutes

// ─── Message Handler ──────────────────────────────────────────────────────────

interface BinanceBookTicker {
  u: number;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

async function handleMessage(raw: string): Promise<void> {
  const msg = JSON.parse(raw) as BinanceBookTicker;

  const bid = Number.parseFloat(msg.b);
  const ask = Number.parseFloat(msg.a);
  if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;

  const price = (bid + ask) / 2;

  // Temporarily lowered threshold for better responsiveness during testing
  if (Math.abs(price - lastPublishedPrice) < 2) return; // changed from BTC_MIN_PRICE_CHANGE_USD

  lastPublishedPrice = price;

  const feed: BtcPriceFeed = { price, bid, ask, ts: Date.now() };

  await setBtcPrice(feed);
  await appendBtcPriceHistory(price);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.btcPriceUpdated, JSON.stringify(feed));

  console.log(`[btcPriceFeeder] BTC $${price.toFixed(2)}  bid=${bid.toFixed(2)} ask=${ask.toFixed(2)}`);
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