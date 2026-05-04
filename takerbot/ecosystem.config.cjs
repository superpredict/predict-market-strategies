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

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

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
      script: TSX,
      args: `${ROOT}/takerbot/feeders/btcPriceFeeder.ts`,
      cwd: ROOT,
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
      script: TSX,
      args: `${ROOT}/takerbot/feeders/chainlinkPriceFeeder.ts`,
      cwd: ROOT,
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
      script: TSX,
      args: `${ROOT}/takerbot/feeders/marketDiscovery.ts`,
      cwd: ROOT,
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
      script: TSX,
      args: `${ROOT}/takerbot/feeders/marketPriceFeeder.ts`,
      cwd: ROOT,
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
      script: TSX,
      args: `${ROOT}/takerbot/updater/fairValueUpdater.ts`,
      cwd: ROOT,
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
    //   script: TSX,
    //   args: `${ROOT}/takerbot/takerbot.ts`,
    //   cwd: ROOT,
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
    //   script: TSX,
    //   args: `${ROOT}/takerbot/portfolio/portfolioTracker.ts`,
    //   cwd: ROOT,
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
