/**
 * takerbot — entry point
 *
 * Bootstraps the TakerStrategy for BTC 15-min markets. Market identity is
 * discovered automatically via the marketDiscovery process — no CLI args needed.
 *
 * On startup:
 *   1. Reads the current active market from Redis key  market:active-btc15m.
 *   2. Starts TakerStrategy for that market.
 *
 * TakerStrategy now owns market rotation: it subscribes to
 * market:new-active-market internally and hot-swaps to the next 15-min window
 * without a process restart (same pattern as marketPriceFeeder).
 *
 * If no active market exists yet, takerbot subscribes once for the very first
 * market event, then hands off rotation entirely to the strategy.
 *
 * Environment variables (see deploy/.env.example):
 *   PRIVATE_KEY   Ethereum wallet private key (required when DRY_RUN=false)
 *   DRY_RUN       true | false (default: true)
 */

import dotenv from 'dotenv';
import { Polymarket } from '@superpredict/ccxt';
import { buildMarketConfigFromInfo } from './config/markets.js';
import { VERBOSE } from './config/constants.js';
import { getRedisClient, getSubscriberClient } from './shared/redis.js';
import { getActiveMarket } from './shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo } from './shared/types.js';
import { TakerStrategy } from './strategy/takerStrategy.js';

dotenv.config();

// ─── State ────────────────────────────────────────────────────────────────────

let exchange: Polymarket;
let currentStrategy: TakerStrategy | null = null;

// ─── Strategy launcher ────────────────────────────────────────────────────────

async function startStrategy(info: ActiveMarketInfo): Promise<void> {
  console.log(
    `[takerbot] starting strategy for market ${info.conditionId.slice(0, 10)}… "${info.question}"`
  );

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

  // TakerStrategy.start() subscribes to market:new-active-market internally,
  // so all future rotations are handled without takerbot's involvement.
  await currentStrategy.start();
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

  console.log('[takerbot] Clearing previous active market on startup...');
  const redis = getRedisClient();
  await redis.del('market:active-btc15m');   // make sure the key name is correct
  
  // Try cold-start: load active market already stored by marketDiscovery
  const existing = await getActiveMarket();
  if (existing) {
    console.log('[takerbot] found active market in Redis, starting strategy…');
    await startStrategy(existing);
    return;
  }

  // No market yet — subscribe once for the very first discovery event,
  // then the strategy owns all future rotations.
  console.log('[takerbot] no active market in Redis yet — waiting for marketDiscovery…');

  const sub = getSubscriberClient();
  await sub.subscribe(REDIS_CHANNELS.newActiveMarket);

  const initialHandler = (channel: string, message: string) => {
    if (channel !== REDIS_CHANNELS.newActiveMarket) return;
    // Remove this one-shot handler before doing async work to avoid re-entry
    sub.off('message', initialHandler);
    void (async () => {
      try {
        const info = JSON.parse(message) as ActiveMarketInfo;
        await startStrategy(info);
        // strategy now handles all subsequent rotations
      } catch (err) {
        console.error('[takerbot] failed to start strategy on first market event:', err);
      }
    })();
  };

  sub.on('message', initialHandler);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[takerbot] ${signal} received — shutting down`);
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
