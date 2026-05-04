/**
 * PM2 ecosystem config for takerbot.
 *
 * All processes start with no market-specific CLI arguments.
 * Market identity is distributed automatically via the marketDiscovery process.
 *
 *   pm2 start takerbot/ecosystem.config.cjs
 *   pm2 start takerbot/ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup   # survive reboots
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * PM2 must never use `node_modules/.bin/tsx` as `script`: that file is a POSIX
 * shell shim; PM2 runs it with Node and you get `SyntaxError` on `basedir=$(`.
 * Use `dist/cli.mjs` (absolute path). Prefer fork mode so PM2 does not wrap the
 * process in cluster mode (which has been observed to keep stale exec paths).
 */
function resolveTsxCli(root) {
  const direct = path.resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(direct)) return direct;
  try {
    return require.resolve('tsx/cli', { paths: [root] });
  } catch {
    /* fall through */
  }
  throw new Error(
    'tsx CLI not found (expected node_modules/tsx/dist/cli.mjs). Run `pnpm install` from repo root.',
  );
}

const TSX_CLI = resolveTsxCli(ROOT);

const prodEnv = {
  NODE_ENV: 'production',
  DRY_RUN: 'false',
  VERBOSE: 'false',
};

const devEnv = {
  NODE_ENV: 'development',
  DRY_RUN: 'true',
  VERBOSE: 'true',
};

module.exports = {
  apps: [
    // ── Shared: BTC price feeder (one instance) ────────────────────────────
    {
      name: 'btcPriceFeeder',
      script: TSX_CLI,
      interpreter: 'node',
      args: `${ROOT}/takerbot/feeders/btcPriceFeeder.ts`,
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 3000,
      max_restarts: 20,
      env: devEnv,
      env_production: prodEnv,
    },

    // ── Shared: Chainlink BTC/USD price feeder (one instance) ──────────────
    // Subscribes to Polymarket's crypto_prices_chainlink WS topic and stores
    // the latest BTC/USD price in Redis for monitoring/diagnostics.
    {
      name: 'chainlinkPriceFeeder',
      script: TSX_CLI,
      interpreter: 'node',
      args: `${ROOT}/takerbot/feeders/chainlinkPriceFeeder.ts`,
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 3000,
      max_restarts: 20,
      env: devEnv,
      env_production: prodEnv,
    },

    // ── Shared: Market discovery / rotation (one instance) ─────────────────
    // Polls Gamma API every 60 s; publishes to market:new-active-market on
    // each new 15-min window so all other processes hot-swap automatically.
    {
      name: 'marketDiscovery',
      script: TSX_CLI,
      interpreter: 'node',
      args: `${ROOT}/takerbot/feeders/marketDiscovery.ts`,
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 5000,
      max_restarts: 20,
      env: devEnv,
      env_production: prodEnv,
    },

    // ── Shared: Polymarket orderbook feeder (one instance) ─────────────────
    // Subscribes to market:new-active-market and hot-swaps Polymarket WS on
    // each rotation.  No market-specific args needed.
    {
      name: 'marketPriceFeeder',
      script: TSX_CLI,
      interpreter: 'node',
      args: `${ROOT}/takerbot/feeders/marketPriceFeeder.ts`,
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 3000,
      max_restarts: 20,
      env: devEnv,
      env_production: prodEnv,
    },

    // ── Shared: Fair value updater (one instance) ──────────────────────────
    // Subscribes to market:new-active-market and switches FV model on each
    // rotation.  No market-specific args needed.
    {
      name: 'fairValueUpdater',
      script: TSX_CLI,
      interpreter: 'node',
      args: `${ROOT}/takerbot/updater/fairValueUpdater.ts`,
      cwd: ROOT,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 3000,
      max_restarts: 20,
      env: devEnv,
      env_production: prodEnv,
    },

    // // ── Shared: Taker strategy (one instance) ──────────────────────────────
    // // Subscribes to market:new-active-market and restarts TakerStrategy on
    // // each rotation.  No market-specific args needed.
    // {
    //   name: 'takerbot',
    //   script: TSX_CLI,
    //   interpreter: 'node',
    //   args: `${ROOT}/takerbot/takerbot.ts`,
    //   cwd: ROOT,
    //   exec_mode: 'fork',
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '256M',
    //   restart_delay: 5000,
    //   max_restarts: 20,
    //   env: devEnv,
    //   env_production: prodEnv,
    // },

    // // ── Shared: Portfolio tracker (one instance) ───────────────────────────
    // {
    //   name: 'portfolioTracker',
    //   script: TSX_CLI,
    //   interpreter: 'node',
    //   args: `${ROOT}/takerbot/portfolio/portfolioTracker.ts`,
    //   cwd: ROOT,
    //   exec_mode: 'fork',
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '128M',
    //   restart_delay: 3000,
    //   max_restarts: 20,
    //   env: devEnv,
    //   env_production: prodEnv,
    // },
  ],
};
