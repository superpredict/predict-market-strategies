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
import { getActiveMarket, setDepthPressure, setOrderbook } from '../shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo, type MarketOrderbookFeed } from '../shared/types.js';

dotenv.config();

// ─── Feeder state ─────────────────────────────────────────────────────────────

const polyWs = new PolymarketWebSocket({ verbose: false, autoReconnect: true });

let currentMarketId: string | null = null;
let currentYesTokenId: string | null = null;
let lastBestBid = -1;
let lastBestAsk = -1;

// ─── Depth-surge detection ────────────────────────────────────────────────────

/**
 * Rolling window used to detect sudden depth spikes.
 * Each sample records the number of bid and ask levels at a point in time.
 */
interface DepthSample {
  ts: number;
  bidDepth: number;
  askDepth: number;
}

/**
 * Look-back window for surge detection.
 * A "surge" is triggered when depth increases meaningfully within this period.
 */
const SURGE_WINDOW_MS = 30_000;

/**
 * A depth side is considered "surging" when BOTH conditions hold within
 * SURGE_WINDOW_MS:
 *   - absolute increase ≥ SURGE_ABS_THRESHOLD levels
 *   - relative increase ≥ SURGE_PCT_THRESHOLD  (e.g. 0.25 = 25 %)
 */
const SURGE_ABS_THRESHOLD = 5;
const SURGE_PCT_THRESHOLD = 0.25;

/**
 * How long after the last detected surge before the signal auto-resets to 0.
 * Also used as the Redis key TTL buffer.
 */
const SURGE_RESET_MS = 30_000;

const depthHistory: DepthSample[] = [];
let currentPressure = 0;
let pressureResetTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Push a new depth sample, prune stale entries, and return the signal:
 *   1  = bid-side depth surged
 *  -1  = ask-side depth surged
 *   0  = no significant change
 *
 * When both sides surge simultaneously the side with the larger relative
 * increase wins; if equal, returns 0 (ambiguous).
 */
function evaluateDepthSurge(bidDepth: number, askDepth: number): number {
  const now = Date.now();
  depthHistory.push({ ts: now, bidDepth, askDepth });

  // Prune anything older than 2 × window (keep headroom for comparison)
  const cutoff = now - SURGE_WINDOW_MS * 2;
  while (depthHistory.length > 1 && depthHistory[0]!.ts < cutoff) {
    depthHistory.shift();
  }

  // Find the oldest sample that is still inside the detection window
  const windowStart = now - SURGE_WINDOW_MS;
  const baseline = depthHistory.find(s => s.ts >= windowStart);
  if (!baseline || baseline === depthHistory[depthHistory.length - 1]) return 0;

  const bidInc = bidDepth - baseline.bidDepth;
  const askInc = askDepth - baseline.askDepth;

  const bidPct = baseline.bidDepth > 0 ? bidInc / baseline.bidDepth : 0;
  const askPct = baseline.askDepth > 0 ? askInc / baseline.askDepth : 0;

  const bidSurge = bidInc >= SURGE_ABS_THRESHOLD && bidPct >= SURGE_PCT_THRESHOLD;
  const askSurge = askInc >= SURGE_ABS_THRESHOLD && askPct >= SURGE_PCT_THRESHOLD;

  if (bidSurge && !askSurge) return 1;
  if (askSurge && !bidSurge) return -1;
  if (bidSurge && askSurge) return bidPct > askPct ? 1 : askPct > bidPct ? -1 : 0;
  return 0;
}

/** Reset depth-surge state when switching to a new market. */
function resetDepthState(): void {
  depthHistory.length = 0;
  currentPressure = 0;
  if (pressureResetTimer !== null) {
    clearTimeout(pressureResetTimer);
    pressureResetTimer = null;
  }
}

/**
 * Evaluate and, if necessary, write the depth-pressure signal to Redis.
 * Schedules an auto-reset after SURGE_RESET_MS when a non-zero signal fires.
 */
async function updateDepthPressure(marketId: string, bidDepth: number, askDepth: number): Promise<void> {
  const signal = evaluateDepthSurge(bidDepth, askDepth);
  const redis = getRedisClient();

  if (signal !== 0) {
    // Cancel any pending reset so the signal stays live while surges continue
    if (pressureResetTimer !== null) {
      clearTimeout(pressureResetTimer);
      pressureResetTimer = null;
    }

    if (signal !== currentPressure) {
      currentPressure = signal;
      await setDepthPressure(redis, marketId, signal);
      console.log(
        `[marketPriceFeeder] depth-pressure → ${signal > 0 ? '+1 (bid surge)' : '-1 (ask surge)'} ` +
        `market=${marketId.slice(0, 10)}… ` +
        `bids=${bidDepth} asks=${askDepth}`
      );
    }

    // Schedule auto-reset
    pressureResetTimer = setTimeout(() => {
      pressureResetTimer = null;
      if (currentMarketId === null) return;
      currentPressure = 0;
      void setDepthPressure(redis, currentMarketId, 0).then(() => {
        console.log(
          `[marketPriceFeeder] depth-pressure → 0 (auto-reset) market=${currentMarketId!.slice(0, 10)}…`
        );
      });
    }, SURGE_RESET_MS);

  } else if (currentPressure !== 0 && pressureResetTimer === null) {
    // Surge dissipated naturally with no pending timer → reset immediately
    currentPressure = 0;
    await setDepthPressure(redis, marketId, 0);
    console.log(
      `[marketPriceFeeder] depth-pressure → 0 (natural reset) market=${marketId.slice(0, 10)}…`
    );
  }
}

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

  // 3. Depth-surge detection
  await updateDepthPressure(marketId, bids.length, asks.length);

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
  resetDepthState();

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
  resetDepthState();
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
