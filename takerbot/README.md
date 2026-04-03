# takerbot — Polymarket BTC 15-Min Taker Strategy

> **Version 3 — Chainlink Strike Price + BTC Stale Forbid**
> Targets "Bitcoin Up or Down" 15-min markets on Polymarket.
> Market identity is discovered automatically — no CLI arguments required.
> All processes hot-swap to the next 15-min window without restarting.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  VPS (AWS us-east-1) or local machine                                │
│                                                                      │
│  PM2 Process Manager                                                 │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  [marketDiscovery]   Gamma API → detects new 15-min window   │    │
│  │         │  reads Chainlink history → sets strike price       │    │
│  │         │  publishes ActiveMarketInfo every ~15 min          │    │
│  │         │  Redis channel: market:new-active-market           │    │
│  │         │  Redis key:     market:active-btc15m (cold-start)  │    │
│  │         │                                                    │    │
│  │         ▼                                                    │    │
│  │  ┌──────────────────────────────────────────────────────┐    │    │
│  │  │  All subscribe to market:new-active-market           │    │    │
│  │  │                                                      │    │    │
│  │  │  [btcPriceFeeder]         Binance WS → BTC bid/ask   │    │    │
│  │  │  [chainlinkPriceFeeder]   Polymarket Chainlink WS    │    │    │
│  │  │                           → BTC/USD price history    │    │    │
│  │  │  [marketPriceFeeder]      Polymarket WS → orderbook  │    │    │
│  │  │         │                      │              │      │    │    │
│  │  │         └──────────────────────┴──────────────┘      │    │    │
│  │  │                    │ Redis pub/sub                   │    │    │
│  │  │                    ▼                                 │    │    │
│  │  │  [fairValueUpdater]  Chainlink-strike FV → Redis     │    │    │
│  │  │                    │ Redis pub/sub (fv:updated:*)    │    │    │
│  │  │                    ▼                                 │    │    │
│  │  │  [takerbot]          BUY/SELL if edge ≥ threshold    │    │    │
│  │  │                                                      │    │    │
│  │  │  [portfolioTracker]  Tracks fills, P&L (shared)      │    │    │
│  │  └──────────────────────────────────────────────────────┘    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Redis (127.0.0.1:6379)  — shared memory bus                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Process Responsibilities

| Process | Instances | Role |
|---|---|---|
| `marketDiscovery` | 1 (shared) | Polls Gamma API every 60 s; reads Chainlink history to set strike price; publishes market info on each 15-min window |
| `btcPriceFeeder` | 1 (shared) | Binance WS → BTC mid price → Redis (ping/pong keepalive, exponential backoff, 23 h forced reconnect) |
| `chainlinkPriceFeeder` | 1 (shared) | Polymarket `crypto_prices_chainlink` WS → BTC/USD price history → Redis; used by `marketDiscovery` to set the strike price at each window open |
| `marketPriceFeeder` | 1 (shared) | Polymarket CLOB WS → orderbook → Redis; hot-swaps token on rotation |
| `fairValueUpdater` | 1 (shared) | Subscribes feeds → STRIKE model FV → Redis; hard-forbids on stale BTC or missing strike |
| `takerbot` | 1 (shared) | Strategy: subscribes FV → places taker orders; restarts TakerStrategy on rotation |
| `portfolioTracker` | 1 (shared) | Subscribes fills → P&L accounting |

### Market Rotation Flow

```
Every 15 minutes:

  marketDiscovery          Redis                  All other processes
       │                     │                          │
       │── GET slug ──▶ Gamma API                       │
       │◀── market data ──────────────────────          │
       │── GET chainlink history ──▶ Redis              │
       │   (find price closest to windowTs)             │
       │── SET market:active-btc15m ─▶ Redis            │
       │── PUBLISH market:new-active-market ──▶ Redis ──▶ (hot-swap)
       │                                                 │
       │                               marketPriceFeeder: disconnect old WS,
       │                                                 connect new token
       │                               fairValueUpdater: apply new STRIKE_PRICE,
       │                                                 unsubscribe old orderbook,
       │                                                 subscribe new one
       │                               takerbot:         stop old strategy,
       │                                                 start new strategy
```

---

## Fair Value Model

### STRIKE model

For each 15-minute window, Polymarket uses the Chainlink BTC/USD oracle price at window
open as the strike price. `marketDiscovery` reads the Chainlink price history from Redis
and finds the entry whose `chainlinkTs` is closest to the window start timestamp, then
publishes it inside `ActiveMarketInfo.strikePrice`. `fairValueUpdater` uses this directly.

```
FV = clamp(0.5 + (S − K) / K × FV_SCALE, 0.05, 0.95)

S = current BTC price (Binance mid)
K = strike price (Chainlink BTC/USD at window open)
```

Examples with `FV_SCALE = 5`:

| BTC vs strike | Relative distance | FV |
|---|---|---|
| +2% above | +0.02 | 0.60 |
| +5% above | +0.05 | 0.75 |
| at strike  | 0.00  | 0.50 |
| −2% below  | −0.02 | 0.40 |
| −10%+ below | ≤ −0.10 | 0.05 (clamped) |

### BTC Staleness Guard

`fairValueUpdater` hard-forbids trading if the Binance BTC feed is older than
`BTC_STALE_FORBID_MS` (30 s):

```
if (Date.now() − btcFeed.ts) > BTC_STALE_FORBID_MS → return immediately
```

Confidence therefore only reflects **orderbook freshness** and **time-to-expiry**.

### No-Strike Guard

If `chainlinkPriceFeeder` was not running when a new window started and no Chainlink
price is available, `strikePrice` is `null` and `fairValueUpdater` hard-forbids all
trading until the next market rotation.

### Decision rule

```
BUY  when  marketAsk  <  FV − edgeThreshold   (market underpriced)
SELL when  marketBid  >  FV + edgeThreshold   (market overpriced)
```

**Safety guards:**
- Hard-forbid if BTC feed is older than `BTC_STALE_FORBID_MS` (30 s)
- Hard-forbid if `strikePrice` is null (Chainlink not available at window open)
- Stop trading `STOP_TRADING_BEFORE_EXPIRY_MS` (60 s) before expiry
- Skip if model confidence < `MIN_CONFIDENCE` (18%)
- Cap exposure at `MAX_EXPOSURE_USDC` per market

---

## Tuning Parameters

**Fair value & strategy** (`config/constants.ts`):

| Constant | Default | Description |
|---|---|---|
| `FV_SCALE` | `5` | Sensitivity: 1% distance from strike → ±0.05 FV |
| `BTC_STALE_FORBID_MS` | `30_000` (30 s) | Hard-forbid trading when Binance BTC feed is older than this |
| `MIN_CONFIDENCE` | `0.18` | Minimum model confidence (0–1) required to trade |
| `STOP_TRADING_BEFORE_EXPIRY_MS` | `60_000` (60 s) | Halt trading this far before expiry |
| `MAX_EXPOSURE_USDC` | `200` | Max open USDC exposure per market |
| `POSITION_SIZE_USDC` | `50` | USDC notional per taker order |
| `EDGE_THRESHOLD` | `0.03` (3%) | Minimum required edge before placing an order |

**Market Discovery** (`config/constants.ts`):

| Constant | Default | Description |
|---|---|---|
| `MIN_MARKET_LIQUIDITY` | `500` USDC | Minimum orderbook liquidity to consider a market tradeable |
| `MIN_TIME_TO_EXPIRY_MS` | `120_000` (2 min) | Skip markets expiring sooner than this |
| `MAX_TIME_TO_EXPIRY_MS` | `1_800_000` (30 min) | Only discover markets expiring within this window |
| `MARKET_DISCOVERY_POLL_MS` | `60_000` (1 min) | How often to poll Gamma API for a new window |

---

## Directory Structure

```
takerbot/
├── config/
│   ├── constants.ts          All tuning parameters (FV_SCALE, BTC_STALE_FORBID_MS, …)
│   └── markets.ts            buildMarketConfigFromInfo() helper
├── shared/
│   ├── types.ts              Shared types + Redis key/channel constants
│   ├── redis.ts              ioredis client factory (client + subscriber)
│   └── state.ts              Typed get/set helpers for Redis
├── feeders/
│   ├── btcPriceFeeder.ts        Binance bookTicker WS → Redis
│   ├── chainlinkPriceFeeder.ts  Polymarket Chainlink WS → BTC/USD price + history
│   ├── marketDiscovery.ts       Gamma API polling → strike price via Chainlink history → market:new-active-market
│   └── marketPriceFeeder.ts     Polymarket CLOB WS → Redis (auto-rotates on new market)
├── updater/
│   └── fairValueUpdater.ts   STRIKE model FV (auto-rotates, hard-forbids on stale data)
├── strategy/
│   └── takerStrategy.ts      Extends Strategy → event-driven taker logic
├── portfolio/
│   └── portfolioTracker.ts   Fill events → P&L snapshot
├── takerbot.ts               Entry point — market-rotating strategy runner
└── ecosystem.config.cjs      PM2 process definitions (no per-market args)
```

---

## Quick Start (Local / Dev)

### Prerequisites
- Node.js ≥ 20
- pnpm
- Redis running locally: `brew install redis && brew services start redis`

### 1. Install dependencies
```bash
pnpm install
```

### 2. Configure environment

```bash
cp deploy/.env.example .env
# Edit .env:
#   PRIVATE_KEY=0x...   (your wallet key; required for live trading)
#   DRY_RUN=true        (keep true until you validate the setup)
```

All strategy parameters are in `takerbot/config/constants.ts`.
No per-market arguments (market ID, token ID, strike, expiry) are needed anywhere.

### 3. Run processes manually (development)

Open 7 terminals, or use PM2:

**Terminal 1 — BTC price feeder (Binance):**
```bash
node --import tsx/esm takerbot/feeders/btcPriceFeeder.ts
```

**Terminal 2 — Chainlink price feeder (Polymarket):**
```bash
node --import tsx/esm takerbot/feeders/chainlinkPriceFeeder.ts
```

**Terminal 3 — Market discovery:**
```bash
node --import tsx/esm takerbot/feeders/marketDiscovery.ts
```

**Terminal 4 — Market price feeder:**
```bash
node --import tsx/esm takerbot/feeders/marketPriceFeeder.ts
```

**Terminal 5 — Fair value updater:**
```bash
node --import tsx/esm takerbot/updater/fairValueUpdater.ts
```

**Terminal 6 — Portfolio tracker:**
```bash
node --import tsx/esm takerbot/portfolio/portfolioTracker.ts
```

**Terminal 7 — Takerbot:**
```bash
node --import tsx/esm takerbot/takerbot.ts
```

### 4. Run with PM2 (recommended)

```bash
pm2 start takerbot/ecosystem.config.cjs
pm2 logs    # watch all logs
pm2 monit   # dashboard
```

For production:
```bash
pm2 start takerbot/ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

---

## Redis Keys & Channels Reference

| Key / Channel | Type | Written by | Read by |
|---|---|---|---|
| `feed:btc:price` | STRING (TTL 60 s) | `btcPriceFeeder` | `fairValueUpdater` |
| `feed:chainlink:btc:price` | STRING (TTL 120 s) | `chainlinkPriceFeeder` | *(latest snapshot)* |
| `feed:chainlink:btc:price:history` | LIST (max 30, TTL 45 min) | `chainlinkPriceFeeder` | `marketDiscovery` (strike price lookup) |
| `market:active-btc15m` | STRING (TTL 30 min) | `marketDiscovery` | all processes (cold-start) |
| `feed:market:{id}:orderbook` | STRING | `marketPriceFeeder` | `fairValueUpdater`, `takerbot` |
| `fv:{id}` | STRING | `fairValueUpdater` | `takerbot` (slow-tick fallback) |
| `position:{id}` | STRING (TTL 24 h) | `takerbot` | `portfolioTracker` |
| `portfolio:snapshot` | STRING (TTL 24 h) | `portfolioTracker` | `portfolioTracker` |
| `btc:price:updated` | CHANNEL | `btcPriceFeeder` | `fairValueUpdater` |
| `chainlink:btc:price:updated` | CHANNEL | `chainlinkPriceFeeder` | *(available for future use)* |
| `market:new-active-market` | CHANNEL | `marketDiscovery` | `marketPriceFeeder`, `fairValueUpdater`, `takerbot` |
| `market:orderbook:updated:{id}` | CHANNEL | `marketPriceFeeder` | `fairValueUpdater` |
| `fv:updated:{id}` | CHANNEL | `fairValueUpdater` | `takerbot` |
| `order:filled:{id}` | CHANNEL | `takerbot` | `portfolioTracker` |

---

## Speed Measurements

Target: **< 50ms** from FV change to order submission.

| Segment | Expected Latency |
|---|---|
| Binance WS → Redis SET | < 5ms |
| Polymarket Chainlink WS → Redis SET | < 5ms |
| Polymarket CLOB WS → Redis SET | < 5ms |
| Redis PUBLISH → fairValueUpdater | < 1ms |
| fairValueUpdater compute + PUBLISH | < 2ms (STRIKE model is O(1)) |
| Redis PUBLISH → takerStrategy | < 1ms |
| takerStrategy evaluate + createOrder | ~10–30ms (Polymarket REST) |
| **Total (VPS us-east-1)** | **~20–45ms** ✓ |

---

## Known Limitations

- **No hedge**: pure directional taker, no cross-venue risk reduction
- **Chainlink dependency**: if `chainlinkPriceFeeder` is down at market rotation, `strikePrice` will be null and trading is forbidden for that window
- **Single WS per feeder**: one Polymarket WS subscription at a time (sufficient for single-market strategy)
- **No fill confirmation**: `fetchOrder` is not polled; position tracking is optimistic

---

## Future Improvements

- **Multi-Exchange BTC Price Feed** — add Bybit, OKX, Coinbase for consensus pricing
- **Real-time fill stream** — subscribe to Polymarket user WS for actual fill confirmation
- **Multiple parallel markets** — run independent strategies on multiple concurrent windows
