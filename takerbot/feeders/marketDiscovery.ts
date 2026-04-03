/**
 * marketDiscovery
 *
 * Polls the Polymarket Gamma API every minute to detect when a new BTC 15-min
 * window has started (slug format: btc-updown-15m-{unixSeconds}).
 *
 * On each new window it:
 *   1. Fetches market details from https://gamma-api.polymarket.com/markets/slug/<slug>
 *   2. Writes the ActiveMarketInfo to Redis key  market:active-btc15m  (cold-start)
 *   3. Publishes to Redis channel  market:new-active-market  (live rotation)
 *
 * All other processes (marketPriceFeeder, fairValueUpdater, takerbot) subscribe
 * to that channel and hot-swap to the new market without restarting.
 *
 * Run as a standalone process via PM2 (one shared instance):
 *   node --import tsx/esm takerbot/feeders/marketDiscovery.ts
 */

import dotenv from 'dotenv';
import { MARKET_DISCOVERY_POLL_MS } from '../config/constants.js';
import { closeRedis, getRedisClient } from '../shared/redis.js';
import { getChainlinkStrikeForWindow, setActiveMarket } from '../shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo } from '../shared/types.js';

dotenv.config();

// ─── Constants ────────────────────────────────────────────────────────────────

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const SLUG_PREFIX = 'btc-updown-15m';
const WINDOW_SECONDS = 900; // 15 minutes

// ─── Gamma API response shape (fields we care about) ─────────────────────────

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  clobTokenIds: string; // JSON-encoded string array, e.g. '["tokenA","tokenB"]'
  active: boolean;
  closed: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unix timestamp (seconds) for the start of the current 15-min window. */
function currentWindowTimestamp(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarketResponse | null> {
  const url = `${GAMMA_API_BASE}/markets/slug/${slug}`;
  console.log(url);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText} for ${url}`);
  return res.json() as Promise<GammaMarketResponse>;
}

// ─── Core discovery logic ─────────────────────────────────────────────────────

let lastPublishedWindowTs = 0;

async function checkAndPublish(): Promise<void> {
  const windowTs = currentWindowTimestamp();

  if (windowTs === lastPublishedWindowTs) return; // same window, nothing to do

  const slug = `${SLUG_PREFIX}-${windowTs}`;
  console.log(`[marketDiscovery] new window detected, fetching slug=${slug}`);

  let market: GammaMarketResponse | null;
  try {
    market = await fetchMarketBySlug(slug);
  } catch (err) {
    console.error('[marketDiscovery] Gamma API error:', err);
    return; // retry next poll interval
  }

  if (!market) {
    console.warn(`[marketDiscovery] no market found for slug=${slug} — will retry`);
    return;
  }

  if (!market.active || market.closed) {
    console.warn(
      `[marketDiscovery] market ${slug} is not active (active=${market.active} closed=${market.closed}) — will retry`
    );
    return;
  }

  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(market.clobTokenIds) as string[];
  } catch {
    console.error('[marketDiscovery] failed to parse clobTokenIds:', market.clobTokenIds);
    return;
  }

  if (tokenIds.length < 2) {
    console.error('[marketDiscovery] market has fewer than 2 token IDs, skipping');
    return;
  }

  // ── Strike price: Chainlink BTC/USD price at window open ──────────────────
  // Polymarket's strike is the Chainlink oracle reading whose unix-second
  // timestamp is exactly the 15-min boundary (divisible by 900).
  // getChainlinkStrikeForWindow finds the entry where chainlinkTs/1000 === windowTs.
  const strikePrice = await getChainlinkStrikeForWindow(windowTs);

  const info: ActiveMarketInfo = {
    conditionId: market.conditionId,
    question: market.question,
    yesTokenId: tokenIds[0]!,
    noTokenId: tokenIds[1]!,
    strikePrice,
    endDate: market.endDate,
    expiryTs: new Date(market.endDate).getTime(),
    slug: market.slug,
    ts: Date.now(),
  };

  // Persist for cold-start reads and broadcast for live rotation
  const redis = getRedisClient();
  await setActiveMarket(info);
  await redis.publish(REDIS_CHANNELS.newActiveMarket, JSON.stringify(info));

  lastPublishedWindowTs = windowTs;

  const strikeLine =
    info.strikePrice !== null
      ? `$${info.strikePrice.toLocaleString()} (chainlink)`
      : 'N/A — chainlinkPriceFeeder not running yet';

  console.log(
    `[marketDiscovery] published market` +
    `\n  conditionId : ${info.conditionId}` +
    `\n  question    : ${info.question}` +
    `\n  yesTokenId  : ${info.yesTokenId.slice(0, 16)}…` +
    `\n  expiry      : ${info.endDate}` +
    `\n  strikePrice : ${strikeLine}`
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  console.log(`[marketDiscovery] starting — polling every ${MARKET_DISCOVERY_POLL_MS / 1000}s`);

  // Run immediately on start so other processes don't wait up to 1 minute
  await checkAndPublish();

  setInterval(() => {
    void checkAndPublish();
  }, MARKET_DISCOVERY_POLL_MS);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[marketDiscovery] shutting down…');
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

start().catch((err) => {
  console.error('[marketDiscovery] fatal:', err);
  process.exit(1);
});
