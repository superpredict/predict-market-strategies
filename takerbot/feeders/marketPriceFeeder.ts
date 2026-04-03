/**
 * marketPriceFeeder
 *
 * Subscribes to the Polymarket CLOB WebSocket for the active BTC 15-min
 * market's "Yes" token orderbook. On each update it writes the orderbook to
 * Redis and publishes to market:orderbook:updated:{conditionId}.
 *
 * Market identity is NOT passed via CLI args. Instead, this process:
 *   1. Reads the current active market from Redis key  market:active-btc15m
 *      at start-up (written by marketDiscovery).
 *   2. Subscribes to Redis channel  market:new-active-market  so it
 *      hot-swaps to the next 15-min market without restarting.
 *
 * Run as a standalone process via PM2 (one instance):
 *   node --import tsx/esm takerbot/feeders/marketPriceFeeder.ts
 */

import dotenv from 'dotenv';
import { PolymarketWebSocket } from '@superpredict/ccxt';
import type { OrderbookUpdate } from '@superpredict/ccxt';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import { getActiveMarket, setOrderbook } from '../shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo, type MarketOrderbookFeed } from '../shared/types.js';

dotenv.config();

// ─── Feeder state ─────────────────────────────────────────────────────────────

const polyWs = new PolymarketWebSocket({ verbose: false, autoReconnect: true });

let currentMarketId: string | null = null;
let currentYesTokenId: string | null = null;
let lastBestBid = -1;
let lastBestAsk = -1;

// ─── Orderbook handler ────────────────────────────────────────────────────────

async function handleOrderbookUpdate(
  marketId: string,
  update: OrderbookUpdate
): Promise<void> {
  if (marketId !== currentMarketId) return;

  const { bids, asks, timestamp } = update;

  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;

  if (bestBid === lastBestBid && bestAsk === lastBestAsk) return;

  lastBestBid = bestBid;
  lastBestAsk = bestAsk;

  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  const feed: MarketOrderbookFeed = {
    marketId,
    yesTokenId: currentYesTokenId!,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    ts: timestamp,
  };

  // 1. Lightweight feed (short TTL for fast access)
  await setOrderbook(feed);

  // 2. Full snapshot with longer TTL for debugging
  const redis = getRedisClient();
  const fullKey = `orderbook:full:${marketId}`;
  await redis.set(fullKey, JSON.stringify({
    ...feed,
    fullBids: bids,
    fullAsks: asks,
  }), 'EX', 300);  // keep for 5 minutes

  await redis.publish(REDIS_CHANNELS.orderbookUpdated(marketId), JSON.stringify(feed));

  console.log(
    `[marketPriceFeeder] ${marketId.slice(0, 10)}… ` +
    `bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)} ` +
    `(depth: ${bids.length} bids, ${asks.length} asks)`
  );
}

// ─── Market switching ─────────────────────────────────────────────────────────

async function switchToMarket(info: ActiveMarketInfo): Promise<void> {
  if (info.conditionId === currentMarketId) {
    console.log(`[marketPriceFeeder] already on market ${info.conditionId.slice(0, 10)}…, skipping`);
    return;
  }

  console.log(
    `[marketPriceFeeder] switching to market ${info.conditionId.slice(0, 10)}… ` +
    `"${info.question}"`
  );

  currentMarketId = info.conditionId;
  currentYesTokenId = info.yesTokenId;
  lastBestBid = -1;
  lastBestAsk = -1;

  // Disconnect current WS session and reconnect with the new token.
  // PolymarketWebSocket.autoReconnect handles the low-level reconnection;
  // we just need to re-call watchOrderbookWithAsset for the new market.
  try {
    await polyWs.disconnect();
  } catch {
    // ignore disconnect errors — the socket may already be closed
  }

  await polyWs.watchOrderbookWithAsset(
    info.conditionId,
    info.yesTokenId,
    (id, update) => void handleOrderbookUpdate(id, update)
  );

  console.log(
    `[marketPriceFeeder] subscribed — market=${info.conditionId} ` +
    `token=${info.yesTokenId.slice(0, 16)}…`
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Subscribe to market rotation events
  const sub = getSubscriberClient();
  await sub.subscribe(REDIS_CHANNELS.newActiveMarket);

  sub.on('message', (channel: string, message: string) => {
    if (channel !== REDIS_CHANNELS.newActiveMarket) return;
    void (async () => {
      try {
        const info = JSON.parse(message) as ActiveMarketInfo;
        await switchToMarket(info);
      } catch (err) {
        console.error('[marketPriceFeeder] rotation error:', err);
      }
    })();
  });

  console.log(
    `[marketPriceFeeder] subscribed to ${REDIS_CHANNELS.newActiveMarket} for market rotation`
  );

  // Cold-start: try to load the already-known active market from Redis
  const existing = await getActiveMarket();
  if (existing) {
    console.log('[marketPriceFeeder] found existing active market in Redis, connecting…');
    await switchToMarket(existing);
  } else {
    console.log('[marketPriceFeeder] no active market in Redis yet — waiting for marketDiscovery…');
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[marketPriceFeeder] shutting down…');
  await polyWs.disconnect();
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

start().catch((err) => {
  console.error('[marketPriceFeeder] fatal:', err);
  process.exit(1);
});
