# takerbot — Polymarket BTC 15-Min Taker Strategy

> **Version 2 — Auto-Rotating Markets**
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
│  │         │  publishes ActiveMarketInfo every ~15 min          │    │
│  │         │  Redis channel: market:new-active-market           │    │
│  │         │  Redis key:     market:active-btc15m (cold-start)  │    │
│  │         │                                                    │    │
│  │         ▼                                                    │    │
│  │  ┌──────────────────────────────────────────────────────┐    │    │
│  │  │  All subscribe to market:new-active-market           │    │    │
│  │  │                                                      │    │    │
│  │  │  [btcPriceFeeder]     Binance WS → BTC bid/ask       │    │    │
│  │  │  [marketPriceFeeder]  Polymarket WS → orderbook      │    │    │
│  │  │         │                      │                     │    │    │
│  │  │         └──────────────────────┘                     │    │    │
│  │  │                    │ Redis pub/sub                   │    │    │
│  │  │                    ▼                                 │    │    │
│  │  │  [fairValueUpdater]  momentum/strike FV → Redis      │    │    │
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
| `marketDiscovery` | 1 (shared) | Polls Gamma API every 60 s; publishes new market info when 15-min window rolls over |
| `btcPriceFeeder` | 1 (shared) | Binance WS → BTC mid price → Redis (ping/pong keepalive, exponential backoff, 23 h forced reconnect; appends rolling price history for momentum) |
| `marketPriceFeeder` | 1 (shared) | Polymarket CLOB WS → orderbook → Redis; hot-swaps token on rotation |
| `fairValueUpdater` | 1 (shared) | Subscribes feeds → computes FV → Redis; switches model on rotation |
| `takerbot` | 1 (shared) | Strategy: subscribes FV → places taker orders; restarts TakerStrategy on rotation |
| `portfolioTracker` | 1 (shared) | Subscribes fills → P&L accounting |

### Market Rotation Flow

```
Every 15 minutes:

  marketDiscovery          Redis                  All other processes
       │                     │                          │
       │── GET slug ──▶ Gamma API                       │
       │◀── market data ──────────────────────          │
       │── SET market:active-btc15m ─▶ Redis            │
       │── PUBLISH market:new-active-market ──▶ Redis ──▶ (hot-swap)
       │                                                 │
       │                               marketPriceFeeder: disconnect old WS,
       │                                                 connect new token
       │                               fairValueUpdater: unsubscribe old
       │                                                 orderbook channel,
       │                                                 subscribe new one
       │                               takerbot:         stop old strategy,
       │                                                 start new strategy
```

---

## Fair Value Models

### MOMENTUM model (default for "Up or Down" markets)

Used when there is no strike price in the market question.

```
momentum = (btcPrice_now − btcPrice_5min_ago) / btcPrice_5min_ago

FV = clamp(0.5 + momentum × MOMENTUM_SCALE, 0.07, 0.93)
```

`btcPrice_5min_ago` is retrieved from a rolling Redis list (`feed:btc:price:history`) that
`btcPriceFeeder` appends to on every price update. `getBtcPriceMsAgo(5min)` finds the
entry closest to 5 minutes ago (must be within ±300 s, otherwise falls back to FV = 0.5).

**Tuning** (in `config/constants.ts`):

| Constant | Default | Description |
|---|---|---|
| `MOMENTUM_LOOKBACK_MS` | `300_000` (5 min) | How far back to look for reference price |
| `MOMENTUM_SCALE` | `30` | Sensitivity: 1% BTC move → ±0.30 FV shift |
| `FV_SCALE` | `5` | Sensitivity for STRIKE model: 1% distance → ±0.05 FV shift |
| `MIN_CONFIDENCE` | `0.22` | Minimum model confidence (0–1) required to trade |
| `STOP_TRADING_BEFORE_EXPIRY_MS` | `60_000` (60 s) | Halt trading this far before expiry |
| `MAX_EXPOSURE_USDC` | `200` | Max open USDC exposure per market |
| `POSITION_SIZE_USDC` | `50` | USDC notional per taker order |
| `EDGE_THRESHOLD` | `0.03` (3%) | Minimum required edge before placing an order |

**Market Discovery tuning** (in `config/constants.ts`):

| Constant | Default | Description |
|---|---|---|
| `MIN_MARKET_LIQUIDITY` | `500` USDC | Minimum orderbook liquidity to consider a market tradeable |
| `MIN_TIME_TO_EXPIRY_MS` | `120_000` (2 min) | Skip markets expiring sooner than this |
| `MAX_TIME_TO_EXPIRY_MS` | `1_800_000` (30 min) | Only discover markets expiring within this window |
| `MARKET_DISCOVERY_POLL_MS` | `60_000` (1 min) | How often to poll Gamma API for a new window |

Examples with `MOMENTUM_SCALE = 30`:

| 5-min BTC move | FV |
|---|---|
| +2.0% | 0.93 (clamped) |
| +0.5% | 0.65 |
| flat  | 0.50 |
| −0.5% | 0.35 |
| −2.0% | 0.07 (clamped) |

### STRIKE model (legacy, for "Will BTC be above $K?" markets)

```
FV = clamp(0.5 + (S − K) / K × FV_SCALE, 0.05, 0.95)

S = current BTC price, K = strike price
```

The model selector is automatic: if `ActiveMarketInfo.strikePrice` is non-null the
STRIKE model runs; otherwise the MOMENTUM model runs.

### Decision rule (both models)

```
BUY  when  marketAsk  <  FV − edgeThreshold   (market underpriced)
SELL when  marketBid  >  FV + edgeThreshold   (market overpriced)
```

**Safety guards:**
- Stop trading `STOP_TRADING_BEFORE_EXPIRY_MS` (60 s) before expiry
- Skip if model confidence < `MIN_CONFIDENCE` (22%)
- Cap exposure at `MAX_EXPOSURE_USDC` per market

---

## Directory Structure

```
takerbot/
├── config/
│   ├── constants.ts          All tuning parameters (FV_SCALE, MOMENTUM_SCALE, …)
│   └── markets.ts            buildMarketConfigFromInfo() helper
├── shared/
│   ├── types.ts              Shared types + Redis key/channel constants
│   ├── redis.ts              ioredis client factory (client + subscriber)
│   └── state.ts              Typed get/set helpers for Redis
├── feeders/
│   ├── btcPriceFeeder.ts     Binance bookTicker WS → Redis + price history
│   ├── marketDiscovery.ts    Gamma API polling → market:new-active-market
│   └── marketPriceFeeder.ts  Polymarket CLOB WS → Redis (auto-rotates on new market)
├── updater/
│   └── fairValueUpdater.ts   Subscribes feeds → computes & publishes FV (auto-rotates)
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

Open 6 terminals, or use PM2:

**Terminal 1 — BTC price feeder:**
```bash
node --import tsx/esm takerbot/feeders/btcPriceFeeder.ts
```

**Terminal 2 — Market discovery:**
```bash
node --import tsx/esm takerbot/feeders/marketDiscovery.ts
```

**Terminal 3 — Market price feeder:**
```bash
node --import tsx/esm takerbot/feeders/marketPriceFeeder.ts
```

**Terminal 4 — Fair value updater:**
```bash
node --import tsx/esm takerbot/updater/fairValueUpdater.ts
```

**Terminal 5 — Portfolio tracker:**
```bash
node --import tsx/esm takerbot/portfolio/portfolioTracker.ts
```

**Terminal 6 — Takerbot:**
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
| `feed:btc:price` | STRING | `btcPriceFeeder` | `fairValueUpdater` |
| `feed:btc:price:history` | LIST (newest first, max 20) | `btcPriceFeeder` | `fairValueUpdater` (momentum) |
| `market:active-btc15m` | STRING (TTL 30 min) | `marketDiscovery` | all processes (cold-start) |
| `feed:market:{id}:orderbook` | STRING | `marketPriceFeeder` | `fairValueUpdater`, `takerbot` |
| `fv:{id}` | STRING | `fairValueUpdater` | `takerbot` (slow-tick fallback) |
| `position:{id}` | STRING (TTL 24 h) | `takerbot` | `portfolioTracker` |
| `portfolio:snapshot` | STRING (TTL 24 h) | `portfolioTracker` | `portfolioTracker` |
| `btc:price:updated` | CHANNEL | `btcPriceFeeder` | `fairValueUpdater` |
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
| Polymarket WS → Redis SET | < 5ms |
| Redis PUBLISH → fairValueUpdater | < 1ms |
| fairValueUpdater compute + PUBLISH | < 3ms (momentum requires 1 extra Redis LRANGE) |
| Redis PUBLISH → takerStrategy | < 1ms |
| takerStrategy evaluate + createOrder | ~10–30ms (Polymarket REST) |
| **Total (VPS us-east-1)** | **~20–45ms** ✓ |

---

## Known Limitations (v2)

- **No hedge**: pure directional taker, no cross-venue risk reduction
- **Momentum model accuracy**: simple 5-min price change; does not account for mean-reversion near expiry
- **Single WS per feeder**: one Polymarket WS subscription at a time (sufficient for single-market strategy)
- **No fill confirmation**: `fetchOrder` is not polled; position tracking is optimistic

---

## Future Improvements (v3+ Roadmap)

- **Multi-Exchange BTC Price Feed** — add Bybit, OKX, Coinbase for consensus pricing
- **Adaptive momentum window** — shorten lookback as time-to-expiry shrinks
- **Real-time fill stream** — subscribe to Polymarket user WS for actual fill confirmation
- **Multiple parallel markets** — run independent strategies on multiple concurrent windows
