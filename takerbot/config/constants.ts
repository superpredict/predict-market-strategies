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

/**
 * Linear scale factor for the simplified FV model.
 *
 *   FV = clamp(0.5 + (S - K) / K × FV_SCALE, 0.05, 0.95)
 *
 * Examples (FV_SCALE = 5):
 *   BTC 2% above strike  →  FV = 0.5 + 0.02 × 5 = 0.60
 *   BTC 5% above strike  →  FV = 0.5 + 0.05 × 5 = 0.75
 *   BTC 2% below strike  →  FV = 0.5 - 0.02 × 5 = 0.40
 *   BTC 10%+ above strike → clamped to 0.95
 */
export const FV_SCALE = 5;

/** Minimum model confidence (0–1) required to trade. */
export const MIN_CONFIDENCE = 0.22;

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

// ─── Momentum Fair Value Model ────────────────────────────────────────────────

/**
 * Look-back window for momentum FV calculation.
 * We fetch the BTC price from ~5 minutes ago and compare to current price.
 */
export const MOMENTUM_LOOKBACK_MS = 5 * 60 * 1000; // 5 min

/**
 * Momentum sensitivity.  FV = 0.5 + momentumPct × MOMENTUM_SCALE
 *
 * Examples (MOMENTUM_SCALE = 10):
 *   BTC up +0.5% over 5 min  →  FV = 0.5 + 0.005 × 10 = 0.55
 *   BTC up +2% over 5 min    →  FV = 0.5 + 0.02  × 10 = 0.70
 *   BTC down −1% over 5 min  →  FV = 0.5 − 0.01  × 10 = 0.40
 */
export const MOMENTUM_SCALE = 30; //10;

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

// ─── Logging ──────────────────────────────────────────────────────────────────

/** Set to true to enable verbose debug logs across all processes. */
export const VERBOSE = false;

/** How often the portfolio tracker prints a summary (ms). */
export const PORTFOLIO_HEARTBEAT_MS = 30_000;

/** Slow-tick interval for the strategy's poll fallback (ms). */
export const STRATEGY_SLOW_TICK_MS = 10_000;
