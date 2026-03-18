/**
 * PM2 ecosystem config for takerbot.
 *
 * Start all shared services + one takerbot for the target market:
 *   pm2 start takerbot/ecosystem.config.cjs
 *
 * Start with a specific market:
 *   MARKET_ID=0xabc... YES_TOKEN_ID=0xdef... pm2 start takerbot/ecosystem.config.cjs
 *
 * Production (VPS):
 *   pm2 start takerbot/ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup   # survive reboots
 */

'use strict';

const path = require('path');

// Use an absolute path so PM2 can resolve files correctly after system reboots,
// when the working directory at startup may not be the project root.
const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

/** Shared env overrides for production */
const prodEnv = {
  NODE_ENV: 'production',
  DRY_RUN: 'false',
  VERBOSE: 'false',
};

/** Shared env for development */
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

    // ── Per-market: Polymarket orderbook feeder ────────────────────────────
    // Set MARKET_ID and YES_TOKEN_ID env vars before starting.
    {
      name: 'marketPriceFeeder',
      script: TSX,
      args: [
        `${ROOT}/takerbot/feeders/marketPriceFeeder.ts`,
        `--marketid=${process.env.MARKET_ID ?? ''}`,
        `--tokenid=${process.env.YES_TOKEN_ID ?? ''}`,
      ].join(' '),
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

    // ── Per-market: Fair value updater ────────────────────────────────────
    {
      name: 'fairValueUpdater',
      script: TSX,
      args: [
        `${ROOT}/takerbot/updater/fairValueUpdater.ts`,
        `--marketid=${process.env.MARKET_ID ?? ''}`,
        `--strike=${process.env.STRIKE_PRICE ?? ''}`,
        `--expiry=${process.env.EXPIRY_TS ?? ''}`,
      ].join(' '),
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

    // ── Per-market: Taker strategy ────────────────────────────────────────
    {
      name: 'takerbot',
      script: TSX,
      args: `${ROOT}/takerbot/takerbot.ts`,
      cwd: ROOT,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 5000,
      max_restarts: 10,
      // Exit code 0 means intentional shutdown (market expiry). Do not count
      // these as crashes so max_restarts is not exhausted during normal operation.
      stop_exit_codes: [0],
      env: devEnv,
      env_production: prodEnv,
    },

    // ── Shared: Portfolio tracker (one instance) ───────────────────────────
    {
      name: 'portfolioTracker',
      script: TSX,
      args: `${ROOT}/takerbot/portfolio/portfolioTracker.ts`,
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
  ],
};
