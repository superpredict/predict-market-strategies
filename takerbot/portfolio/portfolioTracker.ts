/**
 * portfolioTracker
 *
 * Subscribes to Redis for order-filled events across all active markets.
 * Maintains a rolling P&L snapshot and logs a summary on each update.
 *
 * Run as a standalone process via PM2 (one instance shared by all strategies).
 *
 *   node --import tsx/esm takerbot/portfolio/portfolioTracker.ts
 */

import dotenv from 'dotenv';
import { PORTFOLIO_HEARTBEAT_MS } from '../config/constants.js';
import { closeRedis, getSubscriberClient } from '../shared/redis.js';
import {
  getPortfolioSnapshot,
  getPosition,
  setPortfolioSnapshot,
} from '../shared/state.js';
import {
  type PortfolioPosition,
} from '../shared/types.js';

dotenv.config();

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FilledEvent {
  marketId: string;
  outcome: string;
  side: 'buy' | 'sell';
  price: number;
  shares: number;
  ts: number;
}

async function handleFill(event: FilledEvent): Promise<void> {
  const existing = await getPosition(event.marketId);
  const position = existing ?? {
    marketId: event.marketId,
    outcome: event.outcome,
    size: 0,
    avgEntryPrice: 0,
    currentPrice: event.price,
    unrealizedPnl: 0,
    realizedPnl: 0,
    ts: event.ts,
  };

  const isBuy = event.side === 'buy';

  if (isBuy) {
    const totalShares = position.size + event.shares;
    const newAvg =
      (position.avgEntryPrice * position.size + event.price * event.shares) / totalShares;
    position.size = totalShares;
    position.avgEntryPrice = newAvg;
    position.currentPrice = event.price;
  } else {
    // Selling closes (or reverses) the position. Record realized P&L.
    const closedShares = Math.min(position.size, event.shares);
    const realizedPerShare = event.price - position.avgEntryPrice;
    position.realizedPnl += closedShares * realizedPerShare;
    position.size -= closedShares;
    position.currentPrice = event.price;
  }

  position.unrealizedPnl = position.size * (position.currentPrice - position.avgEntryPrice);
  position.ts = event.ts;

  await updateSnapshot(position);
  printPosition(position);
}

async function updateSnapshot(updated: PortfolioPosition): Promise<void> {
  const snap = (await getPortfolioSnapshot()) ?? {
    totalRealizedPnl: 0,
    totalUnrealizedPnl: 0,
    openPositions: [],
    ts: Date.now(),
  };

  const idx = snap.openPositions.findIndex((p) => p.marketId === updated.marketId);
  if (idx >= 0) {
    snap.openPositions[idx] = updated;
  } else {
    snap.openPositions.push(updated);
  }

  // Compute totals before filtering so realized P&L from closing trades is preserved.
  snap.totalRealizedPnl = snap.openPositions.reduce((s, p) => s + p.realizedPnl, 0);
  snap.totalUnrealizedPnl = snap.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  snap.ts = Date.now();

  // Remove fully closed positions to prevent unbounded array growth.
  snap.openPositions = snap.openPositions.filter((p) => Math.abs(p.size) > 0);

  await setPortfolioSnapshot(snap);
}

function printPosition(pos: PortfolioPosition): void {
  console.log(
    `[portfolioTracker] ${pos.marketId.slice(0, 10)}… ` +
    `size=${pos.size.toFixed(2)} avg=${pos.avgEntryPrice.toFixed(3)} ` +
    `unrealizedPnl=$${pos.unrealizedPnl.toFixed(4)} ` +
    `realizedPnl=$${pos.realizedPnl.toFixed(4)}`
  );
}

async function printSummary(): Promise<void> {
  const snap = await getPortfolioSnapshot();
  if (!snap) return;

  const openCount = snap.openPositions.filter((p) => Math.abs(p.size) > 0).length;
  console.log(
    `[portfolioTracker] ── SUMMARY ──  ` +
    `openPositions=${openCount}  ` +
    `realizedPnl=$${snap.totalRealizedPnl.toFixed(4)}  ` +
    `unrealizedPnl=$${snap.totalUnrealizedPnl.toFixed(4)}`
  );
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const sub = getSubscriberClient();

  // Subscribe to wildcard pattern for all order:filled:* channels
  await sub.psubscribe('order:filled:*');
  console.log('[portfolioTracker] subscribed to order:filled:* events');

  sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
    void (async () => {
      try {
        const event = JSON.parse(message) as FilledEvent;
        await handleFill(event);
      } catch (err) {
        console.error('[portfolioTracker] error processing fill:', err);
      }
    })();
  });

  // Heartbeat summary log
  setInterval(() => void printSummary(), PORTFOLIO_HEARTBEAT_MS);

  // Initial summary on startup
  await printSummary();
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('[portfolioTracker] shutting down…');
  await printSummary();
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Start ────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[portfolioTracker] fatal:', err);
  process.exit(1);
});
