/**
 * takerbot — entry point
 *
 * Bootstraps the TakerStrategy for a single Polymarket BTC 15-min market.
 *
 * Usage:
 *   # Auto-discover the current active BTC 15-min market:
 *   node --import tsx/esm takerbot/takerbot.ts
 *
 *   # Trade a specific market by condition ID:
 *   node --import tsx/esm takerbot/takerbot.ts --marketid=0xabc...
 *
 * Environment variables (see deploy/.env.example):
 *   PRIVATE_KEY   Ethereum wallet private key (required when DRY_RUN=false)
 *   DRY_RUN       true | false (default: true — always dry-run unless explicitly set)
 *
 * All strategy tuning parameters (position size, edge threshold, exposure cap,
 * confidence threshold, etc.) are static constants in config/constants.ts.
 */

import dotenv from 'dotenv';
import { Polymarket } from '@superpredict/ccxt';
import { buildMarketConfig, findActiveBtc15MinMarket } from './config/markets.js';
import { VERBOSE } from './config/constants.js';
import { TakerStrategy } from './strategy/takerStrategy.js';

dotenv.config();

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg?.slice(flag.length);
}

const EXPLICIT_MARKET_ID = getArg('marketid') ?? process.env['MARKET_ID'];

// ─── Main ─────────────────────────────────────────────────────────────────────

let strategy: TakerStrategy | null = null;

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

  const exchange = new Polymarket({
    privateKey,
    verbose: VERBOSE,
  });

  let marketConfig;

  if (EXPLICIT_MARKET_ID) {
    console.log(`[takerbot] using explicit market ID: ${EXPLICIT_MARKET_ID}`);
    marketConfig = await buildMarketConfig(exchange, EXPLICIT_MARKET_ID);
  } else {
    console.log('[takerbot] auto-discovering active BTC 15-min market…');
    const result = await findActiveBtc15MinMarket(exchange);
    if (!result) {
      console.error('[takerbot] no active BTC 15-min market found, exiting');
      process.exit(1);
    }
    marketConfig = result.config;
    console.log(`[takerbot] found market: "${marketConfig.question}"`);
  }

  console.log(`[takerbot] market   : ${marketConfig.marketId}`);
  console.log(`[takerbot] expiry   : ${marketConfig.expiryTime.toISOString()}`);
  console.log(`[takerbot] strike   : ${marketConfig.strikePrice ?? 'N/A (up/down)'}`);
  console.log(`[takerbot] dryRun   : ${marketConfig.dryRun}`);
  console.log(`[takerbot] size     : $${marketConfig.positionSizeUsdc} USDC per trade`);
  console.log(`[takerbot] edge     : ${(marketConfig.edgeThreshold * 100).toFixed(1)}% required`);

  strategy = new TakerStrategy(exchange, marketConfig);

  strategy.on('error', (err: Error) => {
    console.error('[takerbot] strategy error:', err);
  });

  strategy.on('order', (order) => {
    console.log(`[takerbot] order event: id=${order.id} side=${order.side} price=${order.price}`);
  });

  await strategy.start();

  // Auto-shutdown 60 s before market expiry
  const msUntilExpiry = marketConfig.expiryTime.getTime() - Date.now();
  const shutdownIn = Math.max(0, msUntilExpiry - 60 * 1000);

  console.log(
    `[takerbot] will auto-shutdown in ${Math.round(shutdownIn / 1000)}s (60s before expiry)`
  );

  setTimeout(() => {
    console.log('[takerbot] market approaching expiry — shutting down strategy');
    void strategy!.stop().then(() => process.exit(0));
  }, shutdownIn);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

function gracefulShutdown(signal: string): void {
  console.log(`[takerbot] ${signal} received — shutting down`);
  if (strategy) {
    void strategy.stop().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch((err) => {
  console.error('[takerbot] fatal error:', err);
  process.exit(1);
});
