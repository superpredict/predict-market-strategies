/**
 * marketPriceFeeder
 *
 * Subscribes to the Polymarket CLOB WebSocket for the target market's
 * "Yes" token orderbook. On each update it writes the orderbook to Redis
 * and publishes to the market:orderbook:updated:{marketId} channel.
 *
 * Run as a standalone process via PM2 (one per market).
 *
 *   node --import tsx/esm takerbot/feeders/marketPriceFeeder.ts --marketid=<conditionId>
 */

import dotenv from 'dotenv';
import { PolymarketWebSocket } from '@superpredict/ccxt';
import type { OrderbookUpdate } from '@superpredict/ccxt';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { setOrderbook } from '../shared/state.js';
import { REDIS_CHANNELS, type MarketOrderbookFeed } from '../shared/types.js';

dotenv.config();

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg?.slice(flag.length);
}

const MARKET_ID = getArg('marketid') ?? process.env['MARKET_ID'];
const YES_TOKEN_ID = getArg('tokenid') ?? process.env['YES_TOKEN_ID'];

if (!MARKET_ID || !YES_TOKEN_ID) {
  console.error(
    '[marketPriceFeeder] Usage: tsx marketPriceFeeder.ts --marketid=<conditionId> --tokenid=<yesTokenId>'
  );
  process.exit(1);
}

// ─── Feeder ───────────────────────────────────────────────────────────────────

const polyWs = new PolymarketWebSocket({ verbose: false, autoReconnect: true });

let lastBestBid = -1;
let lastBestAsk = -1;

async function handleOrderbookUpdate(
  marketId: string,
  update: OrderbookUpdate
): Promise<void> {
  const { bids, asks, timestamp } = update;

  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;

  if (bestBid === lastBestBid && bestAsk === lastBestAsk) return;

  lastBestBid = bestBid;
  lastBestAsk = bestAsk;

  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  const feed: MarketOrderbookFeed = {
    marketId,
    yesTokenId: YES_TOKEN_ID!,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    ts: timestamp,
  };

  await setOrderbook(feed);

  const redis = getRedisClient();
  await redis.publish(
    REDIS_CHANNELS.orderbookUpdated(marketId),
    JSON.stringify(feed)
  );

  console.log(
    `[marketPriceFeeder] ${marketId.slice(0, 10)}… ` +
    `bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)} mid=${mid.toFixed(3)}`
  );
}

async function start(): Promise<void> {
  console.log(`[marketPriceFeeder] subscribing market=${MARKET_ID} token=${YES_TOKEN_ID}`);
  await polyWs.watchOrderbookWithAsset(
    MARKET_ID!,
    YES_TOKEN_ID!,
    (id, update) => void handleOrderbookUpdate(id, update)
  );
  console.log('[marketPriceFeeder] WebSocket connected and subscribed');
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

// ─── Start ────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[marketPriceFeeder] fatal:', err);
  process.exit(1);
});
