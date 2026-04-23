/**
 * Takerbot configuration constants.
 *
 * Only secrets (PRIVATE_KEY, DRY_RUN) live in .env.
 * Everything here is static config — change and redeploy.
 */

// ─── Strategy ─────────────────────────────────────────────────────────────────

/** USDC amount per taker trade. */
export const POSITION_SIZE_USDC = 50;

/** Minimum edge (0–1) required before placing a taker order. 0.03 = 3%. */
export const EDGE_THRESHOLD = 0.03;

/** Maximum open USDC exposure per market. */
export const MAX_EXPOSURE_USDC = 200;

// ─── Fair Value Model ─────────────────────────────────────────────────────────

/** EWMA decay factor for BTC volatility estimation from Chainlink tick data. */
export const VOLATILITY_EWMA_LAMBDA = 0.94;

/** Minimum tick count before the per-second EWMA sigma is considered usable. */
export const VOLATILITY_MIN_TICKS = 3;

/** Minimum model confidence (0–1) required to trade. */
export const MIN_CONFIDENCE = 0.18;

/** Stop trading this many ms before expiry (model breaks down near expiry). */
export const STOP_TRADING_BEFORE_EXPIRY_MS = 60_000;

// ─── Market Discovery ─────────────────────────────────────────────────────────

/** Minimum USDC liquidity for a market to be considered tradeable. */
export const MIN_MARKET_LIQUIDITY = 500;

/** Only trade markets expiring at least this far in the future. */
export const MIN_TIME_TO_EXPIRY_MS = 2 * 60 * 1000; // 2 min

/** Only discover markets expiring within this window. */
export const MAX_TIME_TO_EXPIRY_MS = 30 * 60 * 1000; // 30 min

/** How often marketDiscovery polls for a new 15-min window (ms). */
export const MARKET_DISCOVERY_POLL_MS = 60_000; // 1 min

// ─── Redis ────────────────────────────────────────────────────────────────────

/** Redis connection URL. Change if Redis runs on a non-default port/host. */
export const REDIS_URL = 'redis://127.0.0.1:6379';

/** TTL (seconds) for feed keys. Stale data older than this is ignored. */
export const FEED_TTL_SECONDS = 60;

// ─── BTC Price Feeder ─────────────────────────────────────────────────────────

/** Min absolute USD price change before publishing a new BTC price update. */
export const BTC_MIN_PRICE_CHANGE_USD = 3;

/** Reconnect delay on WS disconnect (ms). */
export const WS_RECONNECT_DELAY_MS = 3_000;

/**
 * Maximum age of a BTC price feed before fairValueUpdater hard-forbids trading.
 * Replaces the old btcStaleness factor in confidence — stale BTC is now a
 * binary forbid rather than a soft confidence penalty.
 */
export const BTC_STALE_FORBID_MS = 30_000; // 30 seconds

// ─── Logging ──────────────────────────────────────────────────────────────────

/** Set to true to enable verbose debug logs across all processes. */
export const VERBOSE = false;

/** How often the portfolio tracker prints a summary (ms). */
export const PORTFOLIO_HEARTBEAT_MS = 30_000;

/** Slow-tick interval for the strategy's poll fallback (ms). */
export const STRATEGY_SLOW_TICK_MS = 10_000;
