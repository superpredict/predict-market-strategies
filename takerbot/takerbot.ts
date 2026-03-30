/**
 * takerbot — entry point
 *
 * Bootstraps the TakerStrategy for BTC 15-min markets. Market identity is
 * discovered automatically via the marketDiscovery process — no CLI args needed.
 *
 * On startup:
 *   1. Reads the current active market from Redis key  market:active-btc15m.
 *   2. Starts TakerStrategy for that market.
 *   3. Subscribes to  market:new-active-market  for live rotation events.
 *
 * On each rotation event (every 15 min):
 *   4. Stops the old strategy (closes Redis, unsubscribes WS).
 *   5. Starts a fresh strategy for the new market.
 *   6. Re-subscribes to  market:new-active-market  on the new subscriber client.
 *
 * Environment variables (see deploy/.env.example):
 *   PRIVATE_KEY   Ethereum wallet private key (required when DRY_RUN=false)
 *   DRY_RUN       true | false (default: true)
 */

import dotenv from 'dotenv';
import { Polymarket } from '@superpredict/ccxt';
import { buildMarketConfigFromInfo } from './config/markets.js';
import { STOP_TRADING_BEFORE_EXPIRY_MS, VERBOSE } from './config/constants.js';
import { getRedisClient, getSubscriberClient } from './shared/redis.js';
import { getActiveMarket } from './shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo } from './shared/types.js';
import { TakerStrategy } from './strategy/takerStrategy.js';

dotenv.config();

// ─── State ────────────────────────────────────────────────────────────────────

let exchange: Polymarket;
let currentStrategy: TakerStrategy | null = null;
let stopBeforeExpiryTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Market rotation ──────────────────────────────────────────────────────────

async function rotateToMarket(info: ActiveMarketInfo): Promise<void> {
  console.log(
    `[takerbot] rotating to market ${info.conditionId.slice(0, 10)}… "${info.question}"`
  );

  // Cancel any pending pre-expiry stop timer from the previous market
  if (stopBeforeExpiryTimer) {
    clearTimeout(stopBeforeExpiryTimer);
    stopBeforeExpiryTimer = null;
  }

  // Stop old strategy. TakerStrategy.stop() closes the Redis connections so
  // getSubscriberClient() / getRedisClient() will lazily re-create them below.
  if (currentStrategy) {
    await currentStrategy.stop();
    currentStrategy = null;
  }

  const config = buildMarketConfigFromInfo(info);

  console.log(`[takerbot] market   : ${config.marketId}`);
  console.log(`[takerbot] expiry   : ${config.expiryTime.toISOString()}`);
  console.log(`[takerbot] strike   : ${config.strikePrice ?? 'N/A (up/down momentum)'}`);
  console.log(`[takerbot] dryRun   : ${config.dryRun}`);
  console.log(`[takerbot] size     : $${config.positionSizeUsdc} USDC per trade`);
  console.log(`[takerbot] edge     : ${(config.edgeThreshold * 100).toFixed(1)}% required`);

  currentStrategy = new TakerStrategy(exchange, config);

  currentStrategy.on('error', (err: Error) => {
    console.error('[takerbot] strategy error:', err);
  });

  currentStrategy.on('order', (order: { id: string; side: string; price: number }) => {
    console.log(`[takerbot] order: id=${order.id} side=${order.side} price=${order.price}`);
  });

  await currentStrategy.start();

  // Re-subscribe to market:new-active-market on the fresh subscriber client
  await subscribeToMarketDiscovery();

  // Stop trading STOP_TRADING_BEFORE_EXPIRY_MS before expiry (but don't exit;
  // the next rotation event will start a new strategy for the next window).
  const msUntilStop = Math.max(0, info.expiryTs - Date.now() - STOP_TRADING_BEFORE_EXPIRY_MS);
  stopBeforeExpiryTimer = setTimeout(() => {
    console.log('[takerbot] market near expiry — stopping strategy; awaiting next market…');
    void currentStrategy?.stop().then(() => {
      currentStrategy = null;
    });
  }, msUntilStop);

  console.log(
    `[takerbot] strategy running — will stop ${Math.round(msUntilStop / 1000)}s from now`
  );
}

// ─── Market discovery subscription ───────────────────────────────────────────

async function subscribeToMarketDiscovery(): Promise<void> {
  const sub = getSubscriberClient(); // lazily created / re-created after rotation

  await sub.subscribe(REDIS_CHANNELS.newActiveMarket);

  // Replace any existing listener to avoid duplicate handlers after rotation
  sub.removeAllListeners('message');

  sub.on('message', (channel: string, message: string) => {
    if (channel !== REDIS_CHANNELS.newActiveMarket) return;
    void (async () => {
      try {
        const info = JSON.parse(message) as ActiveMarketInfo;
        await rotateToMarket(info);
      } catch (err) {
        console.error('[takerbot] rotation error:', err);
      }
    })();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const privateKey = process.env['PRIVATE_KEY'];

  if (!privateKey) {
    if (process.env['DRY_RUN'] === 'false') {
      console.error('[takerbot] PRIVATE_KEY is required for live trading (DRY_RUN=false)');
      process.exit(1);
    } else {
      console.warn('[takerbot] No PRIVATE_KEY set — running in DRY_RUN mode');
    }
  }

  exchange = new Polymarket({ privateKey, verbose: VERBOSE });

  // Try cold-start: load active market already stored by marketDiscovery
  const existing = await getActiveMarket();
  if (existing) {
    console.log('[takerbot] found active market in Redis, starting strategy…');
    await rotateToMarket(existing);
  } else {
    // No market yet — subscribe and wait for the first discovery event
    console.log('[takerbot] no active market in Redis yet — waiting for marketDiscovery…');
    await subscribeToMarketDiscovery();
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[takerbot] ${signal} received — shutting down`);
  if (stopBeforeExpiryTimer) clearTimeout(stopBeforeExpiryTimer);
  if (currentStrategy) {
    await currentStrategy.stop();
  } else {
    // No active strategy — still need to close any open Redis connections
    try {
      const redis = getRedisClient();
      await redis.quit();
    } catch { /* ignore */ }
  }
  process.exit(0);
}

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

main().catch((err) => {
  console.error('[takerbot] fatal error:', err);
  process.exit(1);
});
