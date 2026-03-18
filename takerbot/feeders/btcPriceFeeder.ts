/**
 * btcPriceFeeder
 *
 * Subscribes to Binance's public bookTicker WebSocket stream for BTCUSDT.
 * On each update, writes the BTC price to Redis and publishes to the
 * btc:price:updated channel so downstream processes react immediately.
 *
 * Run as a standalone process via PM2 (one instance, shared by all strategies).
 *
 *   node --import tsx/esm takerbot/feeders/btcPriceFeeder.ts
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { BTC_MIN_PRICE_CHANGE_USD, WS_RECONNECT_DELAY_MS } from '../config/constants.js';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { setBtcPrice } from '../shared/state.js';
import { REDIS_CHANNELS, type BtcPriceFeed } from '../shared/types.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';

// ─── State ────────────────────────────────────────────────────────────────────

let lastPublishedPrice = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let ws: WebSocket | null = null;

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect(): void {
  console.log('[btcPriceFeeder] connecting to Binance WS…');

  // Clean up the previous socket before creating a new one to prevent
  // duplicate event listeners and concurrent connection attempts on reconnect.
  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
  }

  ws = new WebSocket(BINANCE_WS_URL);

  ws.on('open', () => {
    console.log('[btcPriceFeeder] connected');
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

  ws.on('close', () => {
    console.warn('[btcPriceFeeder] disconnected — reconnecting in', WS_RECONNECT_DELAY_MS, 'ms');
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, WS_RECONNECT_DELAY_MS);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

interface BinanceBookTicker {
  u: number;  // order book update ID
  s: string;  // symbol
  b: string;  // best bid price
  B: string;  // best bid quantity
  a: string;  // best ask price
  A: string;  // best ask quantity
}

async function handleMessage(raw: string): Promise<void> {
  const msg = JSON.parse(raw) as BinanceBookTicker;

  const bid = Number.parseFloat(msg.b);
  const ask = Number.parseFloat(msg.a);
  if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;

  const price = (bid + ask) / 2;

  // Skip if price has not moved enough
  if (Math.abs(price - lastPublishedPrice) < BTC_MIN_PRICE_CHANGE_USD) return;

  // Update synchronously before any await so concurrent message callbacks that
  // arrive while Redis I/O is in-flight immediately see the new value and are
  // filtered out, preventing duplicate publishes at startup or after reconnect.
  lastPublishedPrice = price;

  const feed: BtcPriceFeed = { price, bid, ask, ts: Date.now() };

  await setBtcPrice(feed);

  const redis = getRedisClient();
  await redis.publish(REDIS_CHANNELS.btcPriceUpdated, JSON.stringify(feed));

  console.log(`[btcPriceFeeder] BTC $${price.toFixed(2)}  bid=${bid} ask=${ask}`);
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
