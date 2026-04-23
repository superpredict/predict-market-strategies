/**
 * Shared types used across all takerbot processes.
 * These types define the shape of data stored in / published through Redis.
 */

// ─── Feed Payloads ────────────────────────────────────────────────────────────

export interface BtcPriceFeed {
  price: number; // mid price (avg of bid/ask)
  bid: number;
  ask: number;
  ts: number; // epoch ms
}

/** Chainlink BTC/USD price snapshot from Polymarket's live-data WS. */
export interface ChainlinkBtcPriceFeed {
  price: number;
  /** Epoch ms when WE received the message (used for staleness check). */
  ts: number;
  /** Timestamp reported inside the Chainlink payload (epoch ms). */
  chainlinkTs: number;
}

export interface MarketOrderbookFeed {
  marketId: string;
  yesTokenId: string;
  bids: [number, number][]; // [price, size][] sorted desc
  asks: [number, number][]; // [price, size][] sorted asc
  bestBid: number;
  bestAsk: number;
  mid: number;
  ts: number; // epoch ms
}

// ─── Fair Value ───────────────────────────────────────────────────────────────

export interface FairValue {
  marketId: string;
  /** Estimated probability that "Yes" resolves (0–1) */
  value: number;
  /** Model confidence (0–1). Lower when data is stale or near-expiry. */
  confidence: number;
  btcPrice: number;
  strikePrice: number | null;
  publishedAt: number;
  timeToExpiryMs: number;
  ts: number; // epoch ms
}

export interface MarketReportPoint {
  marketId: string;
  fairValue: number;
  confidence: number;
  sigma: number | null;
  /** EWMA sigma computed from 1-minute Chainlink samples, in per-second units. */
  sigma1m: number | null;
  /** EWMA sigma computed from 5-minute Chainlink samples, in per-second units. */
  sigma5m: number | null;
  /** Fair value computed with sigma1m (same Black–Scholes contract). */
  fairValueSigma1m: number | null;
  /** Fair value computed with sigma5m (same Black–Scholes contract). */
  fairValueSigma5m: number | null;
  /** Chainlink BTC/USD spot used for the EWMA fair value model (S in Black–Scholes). */
  btcPrice: number;
  /** Chainlink payload timestamp (epoch ms) used by volatility estimator updates. */
  chainlinkTs: number;
  /** Binance book-ticker mid at report time; CSV column `btc_price` in round reports. */
  binanceBtcPrice?: number | null;
  /** Binance source tick timestamp (epoch ms) from btcPriceFeeder payload. */
  binanceTs?: number | null;
  strikePrice: number | null;
  timeToExpiryMs: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  publishedAt: number;
  ts: number; // epoch ms
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

export interface PortfolioPosition {
  marketId: string;
  outcome: string; // "Yes" | "No"
  size: number; // shares
  avgEntryPrice: number; // 0–1 USDC per share
  currentPrice: number;
  unrealizedPnl: number; // USDC
  realizedPnl: number; // USDC
  ts: number; // epoch ms
}

export interface PortfolioSnapshot {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  openPositions: PortfolioPosition[];
  ts: number;
}

// ─── Active Market (published by marketDiscovery) ────────────────────────────

export interface ActiveMarketInfo {
  /** Polymarket condition ID (hex, starts with 0x) */
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  /** Strike price in USD — Vatic active target for this window; null if unavailable */
  strikePrice: number | null;
  /** Deribit mark IV as annualized fractional volatility (e.g. 0.4115 = 41.15%). */
  deribitMarkIvAnnual: number | null;
  /** Deribit option instrument used to source mark IV, e.g. BTC-8MAY26-76000-C. */
  deribitInstrumentName: string | null;
  /** ISO-8601 end date string */
  endDate: string;
  /** End date as epoch ms */
  expiryTs: number;
  /** Gamma API slug, e.g. "btc-updown-15m-1774851300" */
  slug: string;
  /** When this record was discovered (epoch ms) */
  ts: number;
}

// ─── Market Config ────────────────────────────────────────────────────────────

export interface MarketConfig {
  /** Polymarket condition ID (= market ID used in CLOB) */
  marketId: string;
  question: string;
  /** Token ID for the "Yes" outcome */
  yesTokenId: string;
  /** Token ID for the "No" outcome */
  noTokenId: string;
  /** Strike price in USD — Vatic active target for this window */
  strikePrice: number | null;
  expiryTime: Date;
  /** USDC amount per trade */
  positionSizeUsdc: number;
  /** Minimum required edge (0–1) before placing a taker order */
  edgeThreshold: number;
  /** Maximum concurrent USDC exposure in this market */
  maxExposureUsdc: number;
  /** When true, log actions but never submit real orders */
  dryRun: boolean;
}

// ─── Redis Keys & Channels ────────────────────────────────────────────────────

export const REDIS_KEYS = {
  btcPrice: 'feed:btc:price',
  /** Rolling list of recent Binance mid snapshots (JSON strings), same window as chainlink history */
  btcPriceHistory: 'feed:btc:price:history',
  /** Unix seconds of the last raw WS frame received from Binance */
  btcWsLastReceivedSec: 'feed:btc:ws:last-received-sec',
  chainlinkBtcPrice: 'feed:chainlink:btc:price',
  chainlinkBtcPriceHistory: 'feed:chainlink:btc:price:history',
  orderbook: (marketId: string) => `feed:market:${marketId}:orderbook`,
  /**
   * Depth-pressure signal for a market.
   * Values: 1 = bid depth surged, -1 = ask depth surged, 0 = neutral.
   * Published by marketPriceFeeder; auto-expires after DEPTH_PRESSURE_TTL_SEC.
   */
  depthPressure: (marketId: string) => `feed:market:${marketId}:depth-pressure`,
  fairValue: (marketId: string) => `fv:${marketId}`,
  marketReportRows: (marketId: string) => `market:report:rows:${marketId}`,
  position: (marketId: string) => `position:${marketId}`,
  portfolio: 'portfolio:snapshot',
  activeMarket: 'market:active-btc15m',
  marketInfo: (marketId: string) => `market:info:${marketId}`,
  marketInfoBySlug: (slug: string) => `market:info:slug:${slug}`,
} as const;

export const REDIS_CHANNELS = {
  btcPriceUpdated: 'btc:price:updated',
  chainlinkBtcPriceUpdated: 'chainlink:btc:price:updated',
  orderbookUpdated: (marketId: string) => `market:orderbook:updated:${marketId}`,
  /** Published whenever the depth-pressure signal changes (including reset to 0). */
  depthPressureUpdated: (marketId: string) => `market:depth-pressure:updated:${marketId}`,
  fairValueUpdated: (marketId: string) => `fv:updated:${marketId}`,
  orderFilled: (marketId: string) => `order:filled:${marketId}`,
  newActiveMarket: 'market:new-active-market',
} as const;
