# takerbot — Polymarket BTC 15-Min Taker Strategy

> **Version 1 — Taker Only**
> We take in Market A (Polymarket BTC 15-min) based on a fair value.
> No hedging in another market.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  VPS (AWS us-east-1) or local machine                            │
│                                                                  │
│  PM2 Process Manager                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  [btcPriceFeeder]          Binance WS → BTC bid/ask        │  │
│  │  [marketPriceFeeder]       Polymarket WS → orderbook       │  │
│  │         │                       │                          │  │
│  │         └───────────────────────┘                          │  │
│  │                     │ Redis pub/sub                        │  │
│  │                     ▼                                      │  │
│  │  [fairValueUpdater]  Gaussian P(BTC > strike) → FV         │  │
│  │                     │ Redis pub/sub (fv:updated:*)         │  │
│  │                     ▼                                      │  │
│  │  [takerbot]          BUY/SELL if edge ≥ threshold          │  │
│  │                                                            │  │
│  │  [portfolioTracker]  Tracks fills, P&L (shared)            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Redis (127.0.0.1:6379)  — shared memory bus                     │
└──────────────────────────────────────────────────────────────────┘
```

### Process Responsibilities

| Process | Instances | Role |
|---|---|---|
| `btcPriceFeeder` | 1 (shared) | Binance WS → BTC mid price → Redis |
| `marketPriceFeeder` | 1 per market | Polymarket WS orderbook → Redis |
| `fairValueUpdater` | 1 per market | Subscribes feeds → computes FV → Redis |
| `takerbot` | 1 per market | Strategy: subscribes FV → places taker orders |
| `portfolioTracker` | 1 (shared) | Subscribes fills → P&L accounting |

---

## Fair Value Model

For **"Will BTC be above $K at time T?"** markets:

```
FV = Φ(d)    where    d = ln(S / K) / (σ × √T)

S = current BTC price (Binance mid)
K = strike price (parsed from market question)
T = time to expiry (years)
σ = BTC annualized volatility (default: 80%)
Φ = standard normal CDF
```

For **"BTC Up or Down in 15 min"** markets (no strike):
- FV = 0.5 (no directional model in v1; future: add momentum)

**Decision rule:**
```
BUY  when  marketAsk  <  FV − edgeThreshold   (market underpriced)
SELL when  marketBid  >  FV + edgeThreshold   (market overpriced)
```

**Safety guards:**
- Stop trading 90 s before expiry
- Skip if model confidence < 40%
- Cap exposure at `MAX_EXPOSURE_USDC` per market

---

## Directory Structure

```
takerbot/
├── config/
│   └── markets.ts            Auto-discover or build market config
├── shared/
│   ├── types.ts              Shared types + Redis key/channel constants
│   ├── redis.ts              ioredis client factory (client + subscriber)
│   └── state.ts              Typed get/set helpers for Redis
├── feeders/
│   ├── btcPriceFeeder.ts     Binance bookTicker WS → Redis
│   └── marketPriceFeeder.ts  Polymarket CLOB WS → Redis (dedup: skips identical bestBid/bestAsk)
├── updater/
│   └── fairValueUpdater.ts   Subscribes feeds → computes & publishes FV
├── strategy/
│   └── takerStrategy.ts      Extends Strategy → event-driven taker logic
├── portfolio/
│   └── portfolioTracker.ts   Fill events → P&L snapshot
├── takerbot.ts               Entry point (bootstraps TakerStrategy)
└── ecosystem.config.cjs      PM2 process definitions
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

Only two secrets are needed in `.env`:

```bash
cp deploy/.env.example .env
# Edit .env:
#   PRIVATE_KEY=0x...   (your wallet key; required for live trading)
#   DRY_RUN=true        (keep true until you validate the setup)
```

All strategy parameters (`POSITION_SIZE_USDC`, `EDGE_THRESHOLD`, `MAX_EXPOSURE_USDC`, etc.) are static constants in `takerbot/config/constants.ts` — edit them there and redeploy.

Market-specific values (`marketId`, `tokenId`, `strike`, `expiry`) are passed as **CLI arguments** to each per-market process, not via `.env`.

### 3. Run processes manually (development)

Open 5 terminals, or use PM2:

**Terminal 1 — BTC price feeder:**
```bash
pnpm takerbot:btcFeeder
# or: tsx takerbot/feeders/btcPriceFeeder.ts
```

**Terminal 2 — Market price feeder:**
```bash
tsx takerbot/feeders/marketPriceFeeder.ts --marketid=<conditionId> --tokenid=<yesTokenId>
# e.g.:
# tsx takerbot/feeders/marketPriceFeeder.ts \
#   --marketid=1626370 \
#   --tokenid=55933521883741964418954008802633660143685868285820957716526006098810383662498
```

**Terminal 3 — Fair value updater:**
```bash
tsx takerbot/updater/fairValueUpdater.ts \
  --marketid=<conditionId> --strike=<usdStrike> --expiry=<epochMs>
```

**Terminal 4 — Portfolio tracker:**
```bash
pnpm takerbot:portfolio
```

**Terminal 5 — Takerbot (auto-discovers market):**
```bash
pnpm takerbot
```

### 4. Run with PM2 (recommended)

Edit `takerbot/ecosystem.config.cjs` and fill in the market-specific `args` for `marketPriceFeeder`, `fairValueUpdater`, and (if not using auto-discovery) `takerbot`. Then:

```bash
pm2 start takerbot/ecosystem.config.cjs
pm2 logs          # watch all logs
pm2 monit         # dashboard
```

---

## Speed Measurements

Target: **< 50ms** from FV change to order submission.

| Segment                              | Expected Latency (Single Exchange) | Expected Latency (Multi-Exchange) |
|--------------------------------------|------------------------------------|------------------------------------|
| Binance WS → Redis SET               | < 5ms (local Redis)                | 5–10ms (aggregation overhead)      |
| Polymarket WS → Redis SET            | < 5ms                              | < 5ms                              |
| Redis PUBLISH → fairValueUpdater     | < 1ms                              | < 1ms                              |
| fairValueUpdater compute + PUBLISH   | < 2ms                              | < 2ms                              |
| Redis PUBLISH → takerStrategy        | < 1ms                              | < 1ms                              |
| takerStrategy evaluate + createOrder | ~10–30ms (Polymarket REST)         | ~10–30ms                           |
| **Total (VPS us-east-1)**            | **~20–40ms** ✓                     | **~25–50ms** ✓                     |

**Notes**:  
- Single-exchange version (current v1) achieves ~20–40ms — excellent for fast decisions.  
- Multi-exchange version (e.g. Binance + Bybit + OKX, using median) adds ~5–10ms for aggregation but stays well under 50ms target while providing more robust, manipulation-resistant pricing.

---

## Known Limitations (v1)

- **No hedge**: pure directional taker, no cross-venue risk reduction
- **No momentum model**: "Up/Down" markets use FV = 0.5 (no edge)
- **Simplified FV model**: linear interpolation only; replace `computeFairValue()` in `fairValueUpdater.ts` for a more accurate model (e.g. Gaussian, momentum)
- **Single market**: one PM2 instance per market (scale by adding more app entries)
- **No fill confirmation**: `fetchOrder` is not polled — see below

---

## Future Improvements (v2+ Roadmap)

- **Multi-Exchange BTC Price Feed**  
  Currently relies solely on Binance WS for BTC reference price.  
  Future upgrade: modify `btcPriceFeeder.ts` to connect to multiple exchanges (e.g. Bybit, OKX, Coinbase, Kraken) and compute consensus price via median or trimmed mean.  
  Benefits: significantly more accurate and manipulation-resistant pricing.  
  Trade-off: adds ~5–10ms processing overhead, but total latency still <50ms.  

- **Real-time fill stream subscription**  
  Subscribe to Polymarket's user WS for actual fill events instead of optimistic assumptions.

- **Momentum model for Up/Down markets**  
  Add short-term momentum or trend signals so FV is no longer fixed at 0.5 for strike-less markets.