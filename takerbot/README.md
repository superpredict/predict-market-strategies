# takerbot — Polymarket BTC 15-Min Taker Strategy

> **Version 4 — Vatic Strike Price + BTC Stale Forbid**
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
│  │         │  fetches Vatic active target → sets strike price   │    │
│  │         │  auto-generates previous round report on rotation  │    │
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
│  │  │                           → BTC/USD spot snapshots   │    │    │
│  │  │  [marketPriceFeeder]      Polymarket WS → orderbook  │    │    │
│  │  │         │                      │              │      │    │    │
│  │  │         └──────────────────────┴──────────────┘      │    │    │
│  │  │                    │ Redis pub/sub                   │    │    │
│  │  │                    ▼                                 │    │    │
│  │  │  [fairValueUpdater]  strike-based FV → Redis         │    │    │
│  │  │                      + append report rows            │    │    │
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
| `marketDiscovery` | 1 (shared) | Polls Gamma API every 60 s; fetches Vatic active target price for the current 15-min window; auto-generates the previous round report when a new round starts; publishes market info on each rotation |
| `btcPriceFeeder` | 1 (shared) | Binance WS → BTC mid price → Redis (ping/pong keepalive, exponential backoff, 23 h forced reconnect) |
| `chainlinkPriceFeeder` | 1 (shared) | Polymarket `crypto_prices_chainlink` WS → BTC/USD price → Redis for fair value input and diagnostics |
| `marketPriceFeeder` | 1 (shared) | Polymarket CLOB WS → orderbook → Redis; hot-swaps token on rotation |
| `fairValueUpdater` | 1 (shared) | Subscribes Chainlink BTC + orderbook feeds → STRIKE model FV → Redis; records per-update report rows; hard-forbids on stale Chainlink BTC or missing strike |
| `takerbot` | 1 (shared) | Strategy: subscribes FV → places taker orders; restarts TakerStrategy on rotation |
| `portfolioTracker` | 1 (shared) | Subscribes fills → P&L accounting |

### Market Rotation Flow

```
Every 15 minutes:

  marketDiscovery          Redis                  All other processes
       │                     │                          │
       │── GET slug ──▶ Gamma API                       │
       │◀── market data ──────────────────────          │
       │── GET Vatic target ──▶ api.vatic.trading       │
       │   (match target.windowStart to windowTs)       │
       │── GENERATE previous round report (if expired)  │
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

For each 15-minute window, `marketDiscovery` fetches the active BTC `15min` target from
`https://api.vatic.trading/api/v1/targets/active?asset=btc&types=15min` and uses the
entry whose `windowStart` exactly matches the discovered Polymarket window start. That
price is published inside `ActiveMarketInfo.strikePrice`, and `fairValueUpdater` uses it
directly.

```
FV = clamp( N(d2), 0.01, 0.99 )

d2 = [ln(S / K) - (σ² / 2) × T] / (σ × √T)

S = current BTC price (Chainlink BTC/USD)
K = strike price (Vatic active target price for the window)
T = time-to-expiry in seconds
σ = per-second BTC volatility from EWMA
N = standard normal CDF
```

`fairValueUpdater` estimates `σ` dynamically from the Chainlink tick stream using
an exponentially weighted moving average:

```
r_t = ln(S_t / S_{t-1})
σ²_t = λ × σ²_{t-1} + (1 - λ) × (r_t² / Δt)
```

where `Δt` is measured in seconds, so the resulting sigma is already in
per-second units and can be fed directly into `d2`. On startup, the updater
warms the EWMA estimator from recent Redis-backed Chainlink price history, then
keeps updating sigma on each new Chainlink tick.

### BTC Staleness Guard

`fairValueUpdater` hard-forbids trading if the Chainlink BTC feed is older than
`BTC_STALE_FORBID_MS` (30 s):

```
if (Date.now() − btcFeed.ts) > BTC_STALE_FORBID_MS → return immediately
```

Confidence therefore only reflects **time-to-expiry**.

### No-Strike Guard

If the Vatic target API does not return a valid target for the discovered window,
`strikePrice` is `null` and `fairValueUpdater` hard-forbids all trading until the next
market rotation.

### Decision rule

```
BUY  when  marketAsk  <  FV − edgeThreshold   (market underpriced)
SELL when  marketBid  >  FV + edgeThreshold   (market overpriced)
```

**Safety guards:**
- Hard-forbid if Chainlink BTC feed is older than `BTC_STALE_FORBID_MS` (30 s)
- Hard-forbid if `strikePrice` is null (Vatic target unavailable for the active window)
- Stop trading `STOP_TRADING_BEFORE_EXPIRY_MS` (60 s) before expiry
- Skip if model confidence < `MIN_CONFIDENCE` (18%)
- Cap exposure at `MAX_EXPOSURE_USDC` per market

---

## Market Round Reports

At each market rotation, `marketDiscovery` attempts to generate a report for the
previous market once that market is expired. Reports are written to
`takerbot/reports/` as both Markdown and CSV files, with the filename based on the
market slug (for example `btc-updown-15m-1774851300.md` and `.csv`).

`fairValueUpdater` is the source of the row data. On every successful fair-value
publish it appends one Redis-backed report row containing:

- fair value
- confidence
- BTC price
- strike price
- `yes bid` / `yes ask`
- `no bid` / `no ask`
- `timeToExpiryMs`

The generated report adds the following derived columns:

```text
yes token price(t) = yes ask(t)
f(t) = fair value(t) - yes token price(t)
g(t) = (f(t) + f(t-1) + f(t-2) + f(t-3) + f(t-4)) / 5
f(t) - g(t)
```

Notes:

- `g(t)` is blank until 5 rows are available.
- `no bid` and `no ask` are currently synthesized from the yes-side book:
  `no bid = 1 - yes ask`, `no ask = 1 - yes bid`.
- Per-market report rows are stored in Redis with a 7-day TTL and capped at 5000 rows.

### Manual report generation

Generate for the current active market:

```bash
npm run takerbot:marketRoundReport -- --active-market
```

Generate for a specific slug:

```bash
npm run takerbot:marketRoundReport -- --slug btc-updown-15m-1774851300
```

Overwrite existing files:

```bash
npm run takerbot:marketRoundReport -- --slug btc-updown-15m-1774851300 --force
```

---

## Tuning Parameters

**Fair value & strategy** (`config/constants.ts`):

| Constant | Default | Description |
|---|---|---|
| `VOLATILITY_EWMA_LAMBDA` | `0.94` | EWMA decay factor for per-second BTC volatility estimation |
| `VOLATILITY_MIN_TICKS` | `5` | Minimum Chainlink ticks required before sigma is treated as ready |
| `BTC_STALE_FORBID_MS` | `30_000` (30 s) | Hard-forbid trading when Chainlink BTC feed is older than this |
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
├── reports/                  Auto-generated round reports (.md + .csv)
├── shared/
│   ├── types.ts              Shared types + Redis key/channel constants
│   ├── redis.ts              ioredis client factory (client + subscriber)
│   ├── state.ts              Typed get/set helpers for Redis
│   ├── fairValueMath.ts      Black-Scholes p_base fair value helpers
│   └── ewmaVolatility.ts     Per-second EWMA sigma estimator from Chainlink ticks
├── feeders/
│   ├── btcPriceFeeder.ts        Binance bookTicker WS → Redis
│   ├── chainlinkPriceFeeder.ts  Polymarket Chainlink WS → BTC/USD snapshots + history
│   ├── marketDiscovery.ts       Gamma API polling + Vatic target fetch → market:new-active-market
│   └── marketPriceFeeder.ts     Polymarket CLOB WS → Redis (auto-rotates on new market)
├── updater/
│   └── fairValueUpdater.ts   STRIKE model FV (auto-rotates, hard-forbids on stale data)
├── strategy/
│   └── takerStrategy.ts      Extends Strategy → event-driven taker logic
├── portfolio/
│   └── portfolioTracker.ts   Fill events → P&L snapshot
├── tools/
│   ├── generateMarketRoundReport.ts  Manual report CLI
│   ├── marketRoundReport.ts          Markdown/CSV report generator
│   └── priceFeedPairReport.ts        Binance/Chainlink diagnostics
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

**Terminal 2 — Chainlink price feeder (Polymarket, required for fair value):**
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

### 5. Generate a market report manually

```bash
npm run takerbot:marketRoundReport -- --active-market
```

---

## Redis Keys & Channels Reference

| Key / Channel | Type | Written by | Read by |
|---|---|---|---|
| `feed:btc:price` | STRING (TTL 60 s) | `btcPriceFeeder` | diagnostics / price comparison tools |
| `feed:chainlink:btc:price` | STRING (TTL 120 s) | `chainlinkPriceFeeder` | `fairValueUpdater` |
| `feed:chainlink:btc:price:history` | LIST (max 30, TTL 45 min) | `chainlinkPriceFeeder` | diagnostics / price comparison tools |
| `market:active-btc15m` | STRING (TTL 30 min) | `marketDiscovery` | all processes (cold-start) |
| `market:info:{id}` | STRING (TTL 7 d) | `marketDiscovery` | report generator |
| `market:info:slug:{slug}` | STRING (TTL 7 d) | `marketDiscovery` | report generator |
| `market:report:rows:{id}` | LIST (max 5000, TTL 7 d) | `fairValueUpdater` | report generator |
| `feed:market:{id}:orderbook` | STRING | `marketPriceFeeder` | `fairValueUpdater`, `takerbot` |
| `fv:{id}` | STRING | `fairValueUpdater` | `takerbot` (slow-tick fallback) |
| `position:{id}` | STRING (TTL 24 h) | `takerbot` | `portfolioTracker` |
| `portfolio:snapshot` | STRING (TTL 24 h) | `portfolioTracker` | `portfolioTracker` |
| `btc:price:updated` | CHANNEL | `btcPriceFeeder` | diagnostics / price comparison tools |
| `chainlink:btc:price:updated` | CHANNEL | `chainlinkPriceFeeder` | `fairValueUpdater` |
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
- **Vatic target dependency**: if the Vatic `active` target API does not return a valid `15min` BTC target for the current window, `strikePrice` will be null and trading is forbidden for that window
- **Single WS per feeder**: one Polymarket WS subscription at a time (sufficient for single-market strategy)
- **No fill confirmation**: `fetchOrder` is not polled; position tracking is optimistic
- **Synthetic no-side quotes in reports**: `no bid` / `no ask` are derived from the yes-side top of book, not read from a separate no-side orderbook feed
- **Report row cap**: per-market report history is capped at 5000 Redis rows

---

## Future Improvements

- **Multi-Exchange BTC Price Feed** — add Bybit, OKX, Coinbase for consensus pricing
- **Real-time fill stream** — subscribe to Polymarket user WS for actual fill confirmation
- **Multiple parallel markets** — run independent strategies on multiple concurrent windows
