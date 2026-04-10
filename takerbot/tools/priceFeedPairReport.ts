/**
 * priceFeedPairReport — stats on Binance (btcPriceFeeder) vs Chainlink (chainlinkPriceFeeder) prices.
 *
 * Usage:
 *   # Single combined log (e.g. pm2 logs merged, or tee both processes into one file)
 *   npx tsx takerbot/tools/priceFeedPairReport.ts --file combined.log
 *
 *   # Stdin
 *   cat combined.log | npx tsx takerbot/tools/priceFeedPairReport.ts
 *
 *   # Two separate log files — pairs rows where Unix second matches
 *   npx tsx takerbot/tools/priceFeedPairReport.ts --binance-log btc.log --chainlink-log cl.log
 *
 *   # JSON for scripts
 *   npx tsx takerbot/tools/priceFeedPairReport.ts --file combined.log --json
 *
 *   # From Redis rolling history (requires btcPriceFeeder ≥ current version writing feed:btc:price:history)
 *   npx tsx takerbot/tools/priceFeedPairReport.ts --redis
 *
 * Parses lines emitted by:
 *   [btcPriceFeeder] BTC/USD $... (ws_ms: ...)
 *   [chainlinkPriceFeeder] Chainlink BTC/USD $... (chainlink ts: ...) | Binance $... (ws_ms: ...)
 *
 * When Chainlink lines include "| Binance $", one line yields one pair (same instant as feeder saw it).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { closeRedis } from '../shared/redis.js';
import { getBtcPriceHistory, getChainlinkBtcPriceHistory } from '../shared/state.js';
import type { BtcPriceFeed, ChainlinkBtcPriceFeed } from '../shared/types.js';

dotenv.config();

// ─── Parse helpers ─────────────────────────────────────────────────────────────

function parseMoney(s: string): number {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** From a chainlinkPriceFeeder line that includes Binance snapshot */
const RE_CHAINLINK_WITH_BINANCE =
  /\[chainlinkPriceFeeder\][^\n]*Chainlink BTC\/USD \$([0-9,]+(?:\.[0-9]+)?)[^\n]*\(chainlink ts:\s*(\d+)\)[^\n]*\|\s*Binance \$([0-9,]+(?:\.[0-9]+)?)\s*\(ws_ms:\s*(\d+)\)/;

const RE_BTC_LINE =
  /\[btcPriceFeeder\][^\n]*BTC\/USD \$([0-9,]+(?:\.[0-9]+)?)[^\n]*\(ws_ms:\s*(\d+)\)/;

const RE_CHAINLINK_LINE =
  /\[chainlinkPriceFeeder\][^\n]*Chainlink BTC\/USD \$([0-9,]+(?:\.[0-9]+)?)[^\n]*\(chainlink ts:\s*(\d+)\)/;

export interface PricePair {
  chainlink: number;
  binance: number;
  chainlinkTsMs: number;
  binanceWsMs: number;
  unixSec: number;
}

function extractPairsFromText(text: string): PricePair[] {
  const pairs: PricePair[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(RE_CHAINLINK_WITH_BINANCE);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined)
      continue;
    const chainlink = parseMoney(m[1]);
    const chainlinkTsMs = Number(m[2]);
    const binance = parseMoney(m[3]);
    const binanceWsMs = Number(m[4]);
    if ([chainlink, binance, chainlinkTsMs, binanceWsMs].some((x) => !Number.isFinite(x))) continue;
    pairs.push({
      chainlink,
      binance,
      chainlinkTsMs,
      binanceWsMs,
      unixSec: Math.floor(chainlinkTsMs / 1000),
    });
  }
  return pairs;
}

function extractBtcBySec(text: string): Map<number, { price: number; wsMs: number }> {
  const map = new Map<number, { price: number; wsMs: number }>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(RE_BTC_LINE);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const price = parseMoney(m[1]);
    const wsMs = Number(m[2]);
    if (!Number.isFinite(price) || !Number.isFinite(wsMs)) continue;
    const sec = Math.floor(wsMs / 1000);
    map.set(sec, { price, wsMs });
  }
  return map;
}

function extractChainlinkBySec(text: string): Map<number, { price: number; tsMs: number }> {
  const map = new Map<number, { price: number; tsMs: number }>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(RE_CHAINLINK_LINE);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const price = parseMoney(m[1]);
    const tsMs = Number(m[2]);
    if (!Number.isFinite(price) || !Number.isFinite(tsMs)) continue;
    const sec = Math.floor(tsMs / 1000);
    map.set(sec, { price, tsMs });
  }
  return map;
}

/**
 * Pair Chainlink vs Binance by Unix second: chainlink uses oracle chainlinkTs; Binance uses local snapshot ts.
 * When multiple samples share a second, keep the newest (Redis LPUSH order: index 0 = newest).
 */
function pairsFromRedisHistories(
  btcFeeds: BtcPriceFeed[],
  clFeeds: ChainlinkBtcPriceFeed[],
): PricePair[] {
  const btcBySec = new Map<number, BtcPriceFeed>();
  for (let i = btcFeeds.length - 1; i >= 0; i--) {
    const b = btcFeeds[i]!;
    btcBySec.set(Math.floor(b.ts / 1000), b);
  }
  const clBySec = new Map<number, ChainlinkBtcPriceFeed>();
  for (let i = clFeeds.length - 1; i >= 0; i--) {
    const c = clFeeds[i]!;
    clBySec.set(Math.floor(c.chainlinkTs / 1000), c);
  }
  const pairs: PricePair[] = [];
  for (const [sec, c] of clBySec) {
    const b = btcBySec.get(sec);
    if (!b) continue;
    pairs.push({
      chainlink: c.price,
      binance: b.price,
      chainlinkTsMs: c.chainlinkTs,
      binanceWsMs: b.ts,
      unixSec: sec,
    });
  }
  pairs.sort((a, b) => a.unixSec - b.unixSec);
  return pairs;
}

function pairsFromTwoLogs(binanceText: string, chainlinkText: string): PricePair[] {
  const btcMap = extractBtcBySec(binanceText);
  const clMap = extractChainlinkBySec(chainlinkText);
  const pairs: PricePair[] = [];
  for (const [sec, cl] of clMap) {
    const b = btcMap.get(sec);
    if (!b) continue;
    pairs.push({
      chainlink: cl.price,
      binance: b.price,
      chainlinkTsMs: cl.tsMs,
      binanceWsMs: b.wsMs,
      unixSec: sec,
    });
  }
  pairs.sort((a, b) => a.unixSec - b.unixSec);
  return pairs;
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

export interface DiffStats {
  n: number;
  minUsd: number;
  maxUsd: number;
  meanUsd: number;
  stdevUsd: number;
  minBps: number;
  maxBps: number;
  meanBps: number;
  stdevBps: number;
  minAbsUsd: number;
  maxAbsUsd: number;
  meanAbsUsd: number;
  /** median absolute error (USD) */
  medianAbsUsd: number;
}

function computeStats(pairs: PricePair[]): DiffStats | null {
  if (pairs.length === 0) return null;

  const diffsUsd = pairs.map((p) => p.chainlink - p.binance);
  const absUsd = diffsUsd.map((d) => Math.abs(d));
  const refPrices = pairs.map((p) => (p.chainlink + p.binance) / 2);
  const bps = diffsUsd.map((d, i) => {
    const midPrice = refPrices[i];
    return midPrice !== undefined && midPrice !== 0 ? (d / midPrice) * 10_000 : 0;
  });

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdev = (xs: number[], mu: number) => {
    if (xs.length <= 1) return 0;
    const v = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(v);
  };

  const meanUsd = mean(diffsUsd);
  const meanBps = mean(bps);
  const sortedAbs = [...absUsd].sort((a, b) => a - b);
  const mid = Math.floor(sortedAbs.length / 2);
  let medianAbsUsd: number;
  if (sortedAbs.length % 2 === 0) {
    const a = sortedAbs[mid - 1];
    const b = sortedAbs[mid];
    medianAbsUsd = ((a ?? 0) + (b ?? 0)) / 2;
  } else {
    medianAbsUsd = sortedAbs[mid] ?? 0;
  }

  return {
    n: pairs.length,
    minUsd: Math.min(...diffsUsd),
    maxUsd: Math.max(...diffsUsd),
    meanUsd,
    stdevUsd: stdev(diffsUsd, meanUsd),
    minBps: Math.min(...bps),
    maxBps: Math.max(...bps),
    meanBps,
    stdevBps: stdev(bps, meanBps),
    minAbsUsd: Math.min(...absUsd),
    maxAbsUsd: Math.max(...absUsd),
    meanAbsUsd: mean(absUsd),
    medianAbsUsd,
  };
}

function formatReport(pairs: PricePair[], stats: DiffStats | null, source: string): string {
  const lines: string[] = [];
  lines.push('=== BTC price feeder pair report (Chainlink − Binance) ===');
  lines.push(`Source: ${source}`);
  lines.push(`Parsed pairs: ${pairs.length}`);
  if (!stats) {
    lines.push('No pairs found — use --redis (both feeders running + btc history key), or log lines with');
    lines.push('chainlinkPriceFeeder "| Binance $", or --binance-log + --chainlink-log by Unix second.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Difference = Chainlink − Binance (USD)');
  lines.push(`  n                 ${stats.n}`);
  lines.push(`  min               ${stats.minUsd.toFixed(4)}`);
  lines.push(`  max               ${stats.maxUsd.toFixed(4)}`);
  lines.push(`  mean              ${stats.meanUsd.toFixed(4)}`);
  lines.push(`  stdev             ${stats.stdevUsd.toFixed(4)}`);
  lines.push(`  |diff| min        ${stats.minAbsUsd.toFixed(4)}`);
  lines.push(`  |diff| max        ${stats.maxAbsUsd.toFixed(4)}`);
  lines.push(`  |diff| mean       ${stats.meanAbsUsd.toFixed(4)}`);
  lines.push(`  |diff| median     ${stats.medianAbsUsd.toFixed(4)}`);
  lines.push('');
  lines.push('Basis points vs mid price ( (CL−BN) / mid × 10_000 )');
  lines.push(`  min bps           ${stats.minBps.toFixed(3)}`);
  lines.push(`  max bps           ${stats.maxBps.toFixed(3)}`);
  lines.push(`  mean bps          ${stats.meanBps.toFixed(3)}`);
  lines.push(`  stdev bps         ${stats.stdevBps.toFixed(3)}`);
  if (source.includes('Redis')) {
    lines.push('');
    lines.push(
      'Note: Redis only keeps ~30 minutes of rolling history per feed; redeploy btcPriceFeeder so it writes',
    );
    lines.push('feed:btc:price:history — older data still needs logs.');
  }
  return lines.join('\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let file: string | null = null;
  let binanceLog: string | null = null;
  let chainlinkLog: string | null = null;
  let asJson = false;
  let useRedis = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') {
      file = argv[++i] ?? '';
    } else if (a === '--binance-log') {
      binanceLog = argv[++i] ?? '';
    } else if (a === '--chainlink-log') {
      chainlinkLog = argv[++i] ?? '';
    } else if (a === '--json') {
      asJson = true;
    } else if (a === '--redis') {
      useRedis = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`
priceFeedPairReport — Binance vs Chainlink price diff stats from feeder logs

  --redis                    Read rolling history from Redis (feed:btc:price:history + chainlink history)
  --file, -f <path>          Single log file (or use stdin with no --file)
  --binance-log <path>       btcPriceFeeder log
  --chainlink-log <path>     chainlinkPriceFeeder log (paired by Unix second)
  --json                     Print JSON (stats + sample pairs cap)
  --help, -h                 This help

Examples:
  npx tsx takerbot/tools/priceFeedPairReport.ts --redis
  npx tsx takerbot/tools/priceFeedPairReport.ts -f /var/log/takerbot-combined.log
  npx tsx takerbot/tools/priceFeedPairReport.ts --binance-log btc.log --chainlink-log cl.log
  pm2 logs --nostream | npx tsx takerbot/tools/priceFeedPairReport.ts
`);
      process.exit(0);
    }
  }

  let text: string;
  let source: string;

  if (useRedis) {
    try {
      const [btcFeeds, clFeeds] = await Promise.all([getBtcPriceHistory(), getChainlinkBtcPriceHistory()]);
      const pairs = pairsFromRedisHistories(btcFeeds, clFeeds);
      const stats = computeStats(pairs);
      source = `Redis (${btcFeeds.length} btc history, ${clFeeds.length} chainlink history rows)`;
      if (asJson) {
        console.log(
          JSON.stringify(
            {
              source,
              stats,
              pairCount: pairs.length,
              btcHistoryLen: btcFeeds.length,
              chainlinkHistoryLen: clFeeds.length,
              samplePairs: pairs.slice(0, 20),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(formatReport(pairs, stats, source));
      }
    } finally {
      await closeRedis();
    }
    return;
  }

  if (binanceLog && chainlinkLog) {
    const bPath = resolve(binanceLog);
    const cPath = resolve(chainlinkLog);
    const bText = readFileSync(bPath, 'utf8');
    const cText = readFileSync(cPath, 'utf8');
    const pairs = pairsFromTwoLogs(bText, cText);
    const stats = computeStats(pairs);
    source = `two-file match: ${bPath} + ${cPath}`;
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            source,
            stats,
            pairCount: pairs.length,
            samplePairs: pairs.slice(0, 20),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatReport(pairs, stats, source));
    }
    return;
  }

  if (file) {
    text = readFileSync(resolve(file), 'utf8');
    source = resolve(file);
  } else if (process.stdin.isTTY) {
    console.error('No input: pass --file <path>, or pipe log text on stdin, or use --binance-log + --chainlink-log');
    process.exit(1);
  } else {
    text = await readStdin();
    source = 'stdin';
  }

  let pairs = extractPairsFromText(text);
  if (pairs.length === 0) {
    const maybeBtc = extractBtcBySec(text);
    const maybeCl = extractChainlinkBySec(text);
    if (maybeBtc.size && maybeCl.size) {
      pairs = pairsFromTwoLogs(text, text);
      source += ' (single file: matched btc + chainlink lines by second)';
    }
  }

  const stats = computeStats(pairs);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          source,
          stats,
          pairCount: pairs.length,
          samplePairs: pairs.slice(0, 20),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(pairs, stats, source));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
