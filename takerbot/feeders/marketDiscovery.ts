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
import { getActiveMarket, setActiveMarket } from '../shared/state.js';
import { REDIS_CHANNELS, type ActiveMarketInfo } from '../shared/types.js';
import { generateMarketRoundReport } from '../tools/marketRoundReport.js';

dotenv.config();

// ─── Constants ────────────────────────────────────────────────────────────────

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const VATIC_TARGETS_URL = 'https://api.vatic.trading/api/v1/targets/active?asset=btc&types=15min';
const DERIBIT_TICKER_URL = 'https://www.deribit.com/api/v2/public/ticker';
const SLUG_PREFIX = 'btc-updown-15m';
const WINDOW_SECONDS = 900; // 15 minutes
const STRIKE_ROUNDING_USD = 1000;

const DERIBIT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

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

interface VaticTarget {
  marketType: string;
  ok: boolean;
  windowStart: number;
  windowStartIso: string;
  source: string;
  price: number;
}

interface VaticTargetsResponse {
  now: string;
  asset: string;
  results: VaticTarget[];
}

interface DeribitTickerResponse {
  jsonrpc: string;
  result?: {
    mark_iv?: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unix timestamp (seconds) for the start of the current 15-min window. */
function currentWindowTimestamp(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function getWeekStartMonday(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  const day = clone.getDay(); // Sunday=0 ... Saturday=6
  const daysSinceMonday = (day + 6) % 7;
  clone.setDate(clone.getDate() - daysSinceMonday);
  return clone;
}

/** "下下個禮拜五": Friday in the week after next. */
function getFridayAfterNext(reference: Date): Date {
  const monday = getWeekStartMonday(reference);
  const result = new Date(monday);
  result.setDate(monday.getDate() + 18); // Monday + (2 weeks + Friday offset 4)
  return result;
}

function formatDeribitExpiry(date: Date): string {
  const day = date.getDate();
  const month = DERIBIT_MONTHS[date.getMonth()];
  const yearTwoDigits = (date.getFullYear() % 100).toString().padStart(2, '0');
  return `${day}${month}${yearTwoDigits}`;
}

function buildDeribitInstrumentName(strikePrice: number): string {
  const targetDate = getFridayAfterNext(new Date());
  const expiry = formatDeribitExpiry(targetDate);
  const roundedStrike = Math.max(
    STRIKE_ROUNDING_USD,
    Math.round(strikePrice / STRIKE_ROUNDING_USD) * STRIKE_ROUNDING_USD,
  );
  return `BTC-${expiry}-${roundedStrike}-C`;
}

async function fetchDeribitMarkIvAnnual(
  strikePrice: number | null,
): Promise<{ instrumentName: string | null; annualVolatility: number | null }> {
  if (strikePrice === null || !Number.isFinite(strikePrice) || strikePrice <= 0) {
    return { instrumentName: null, annualVolatility: null };
  }

  const instrumentName = buildDeribitInstrumentName(strikePrice);
  const url = `${DERIBIT_TICKER_URL}?instrument_name=${encodeURIComponent(instrumentName)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Deribit API ${res.status}: ${res.statusText} for ${url}`);
  }

  const body = (await res.json()) as DeribitTickerResponse;
  const markIv = body.result?.mark_iv;
  if (typeof markIv !== 'number' || !Number.isFinite(markIv) || markIv <= 0) {
    console.warn(
      `[marketDiscovery] invalid Deribit mark_iv for ${instrumentName}: ${String(markIv)}`
    );
    return { instrumentName, annualVolatility: null };
  }

  return { instrumentName, annualVolatility: markIv / 100 };
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarketResponse | null> {
  const url = `${GAMMA_API_BASE}/markets/slug/${slug}`;
  console.log(url);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText} for ${url}`);
  return res.json() as Promise<GammaMarketResponse>;
}

async function fetchStrikePrice(windowTs: number): Promise<number | null> {
  const res = await fetch(VATIC_TARGETS_URL);
  if (!res.ok) {
    throw new Error(`Vatic targets API ${res.status}: ${res.statusText} for ${VATIC_TARGETS_URL}`);
  }

  const body = (await res.json()) as VaticTargetsResponse;
  const target = body.results.find(
    (item) => item.marketType === '15min' && item.windowStart === windowTs
  );

  if (!target) {
    const windows = body.results.map((item) => item.windowStartIso).join(', ') || 'none';
    console.warn(
      `[marketDiscovery] Vatic targets API returned no 15min target for windowTs=${windowTs} ` +
      `(available windows: ${windows})`
    );
    return null;
  }

  if (!target.ok || !Number.isFinite(target.price) || target.price <= 0) {
    console.warn(
      `[marketDiscovery] Vatic target invalid for windowTs=${windowTs}: ` +
      `ok=${target.ok} price=${target.price}`
    );
    return null;
  }

  console.log(
    `[marketDiscovery] Vatic strike target $${target.price.toFixed(2)} ` +
    `(source=${target.source}, windowStart=${target.windowStartIso})`
  );
  return target.price;
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

  // ── Strike price: Vatic active target for the detected 15-min window ──────
  const strikePrice = await fetchStrikePrice(windowTs);
  let deribitInstrumentName: string | null = null;
  let deribitMarkIvAnnual: number | null = null;
  try {
    const deribit = await fetchDeribitMarkIvAnnual(strikePrice);
    deribitInstrumentName = deribit.instrumentName;
    deribitMarkIvAnnual = deribit.annualVolatility;
  } catch (err) {
    console.error('[marketDiscovery] Deribit ticker error:', err);
  }

  const info: ActiveMarketInfo = {
    conditionId: market.conditionId,
    question: market.question,
    yesTokenId: tokenIds[0]!,
    noTokenId: tokenIds[1]!,
    strikePrice,
    deribitMarkIvAnnual,
    deribitInstrumentName,
    endDate: market.endDate,
    expiryTs: new Date(market.endDate).getTime(),
    slug: market.slug,
    ts: Date.now(),
  };

  const previousMarket = await getActiveMarket();
  if (
    previousMarket &&
    previousMarket.conditionId !== info.conditionId &&
    previousMarket.expiryTs <= Date.now()
  ) {
    try {
      const result = await generateMarketRoundReport(previousMarket);
      console.log(
        `[marketDiscovery] ${result.skipped ? 'report already exists' : 'generated report'} ` +
        `for ${previousMarket.slug} rows=${result.rowCount}`
      );
    } catch (err) {
      console.error(
        `[marketDiscovery] failed to generate report for ${previousMarket.slug}:`,
        err
      );
    }
  }

  // Persist for cold-start reads and broadcast for live rotation
  const redis = getRedisClient();
  await setActiveMarket(info);
  await redis.publish(REDIS_CHANNELS.newActiveMarket, JSON.stringify(info));

  lastPublishedWindowTs = windowTs;

  const strikeLine =
    info.strikePrice !== null
      ? `$${info.strikePrice.toLocaleString()} (vatic active target)`
      : 'N/A — Vatic target unavailable';
  const deribitLine =
    info.deribitMarkIvAnnual !== null
      ? `${(info.deribitMarkIvAnnual * 100).toFixed(2)}% (${info.deribitInstrumentName})`
      : `N/A${info.deribitInstrumentName ? ` (${info.deribitInstrumentName})` : ''}`;

  console.log(
    `[marketDiscovery] published market` +
    `\n  conditionId : ${info.conditionId}` +
    `\n  question    : ${info.question}` +
    `\n  yesTokenId  : ${info.yesTokenId.slice(0, 16)}…` +
    `\n  expiry      : ${info.endDate}` +
    `\n  strikePrice : ${strikeLine}` +
    `\n  deribit iv : ${deribitLine}`
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
