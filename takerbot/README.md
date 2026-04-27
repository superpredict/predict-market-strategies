# takerbot — Polymarket BTC 15-Min Taker Strategy

> **Current design (Apr 2026)**
> Targets Polymarket "Bitcoin Up or Down" 15-minute markets.
> Market identity is discovered automatically and all processes rotate hot without restart.

---

## Architecture Overview

```
marketDiscovery
  ├─ polls Gamma and finds active 15m market
  ├─ fetches Vatic strike (+ optional Deribit mark IV)
  ├─ writes market:active-btc15m
  └─ publishes market:new-active-market

btcPriceFeeder (Binance)            chainlinkPriceFeeder (Polymarket)
  ├─ feed:btc:price                   ├─ feed:chainlink:btc:price
  ├─ feed:btc:price:history           └─ feed:chainlink:btc:price:history
  └─ btc:price:updated                └─ chainlink:btc:price:updated

marketPriceFeeder
  ├─ feed:market:{id}:orderbook
  ├─ orderbook:full:{id} (debug snapshot)
  ├─ feed:market:{id}:depth-pressure
  ├─ market:orderbook:updated:{id}
  └─ market:depth-pressure:updated:{id}

fairValueUpdater
  ├─ consumes chainlink + orderbook + current Binance feed
  ├─ computes FV and writes fv:{id}
  ├─ appends market:report:rows:{id}
  └─ publishes fv:updated:{id}

takerbot (strategy)
  ├─ consumes fv:updated:{id} (fast path)
  ├─ polls fv:{id} every slow tick (fallback)
  └─ publishes order:filled:{id}

portfolioTracker
  └─ consumes order:filled:{id} and writes portfolio snapshots
```

### Process Responsibilities

| Process | Instances | Role |
|---|---|---|
| `marketDiscovery` | 1 | Polls Gamma, resolves active 15m market, fetches Vatic strike and Deribit IV, publishes rotations, and generates prior-market report on rotation |
| `btcPriceFeeder` | 1 | Binance bookTicker stream; writes BTC mid, history, WS liveness timestamp |
| `chainlinkPriceFeeder` | 1 | Polymarket Chainlink BTC stream; writes latest and history for sigma/oracle diagnostics |
| `marketPriceFeeder` | 1 | Polymarket orderbook stream; writes top-of-book + full-book debug snapshot + depth-pressure signal |
| `fairValueUpdater` | 1 | Computes strike-based FV, stores report rows, publishes FV updates |
| `takerbot` | 1 | Runs `TakerStrategy`, consumes FV updates, places taker orders, rotates with market |
| `portfolioTracker` | 1 | Tracks fills and P&L snapshots |

### Rotation Flow

On each new 15-minute window:
1. `marketDiscovery` writes `market:active-btc15m` and publishes `market:new-active-market`.
2. `marketPriceFeeder` reconnects to the new market token.
3. `fairValueUpdater` swaps strike/expiry, re-subscribes to the new orderbook channel.
4. `takerbot` rebuilds strategy config and re-subscribes FV channel.

---

## Fair Value Model (Current)

### Strike-based binary call

For each active 15-minute market:

- `K` comes from Vatic active target API (matched to market window start).
- `S` uses **Binance BTC/USDC mid** from `btcPriceFeeder`.
- `sigma` is estimated from Chainlink tick history (per-second EWMA).

```
FV = clamp(N(d2), 0.01, 0.99)
d2 = [ln(S/K) - (sigma^2 / 2) * T] / (sigma * sqrt(T))
```

where:
- `T`: time to expiry in seconds
- `sigma`: per-second volatility

### Volatility tracks used in reports

`fairValueUpdater` maintains:
- base `sigma` (tick-level EWMA)
- `sigma5m` (coarse 5-minute sampled EWMA)
- `sigma10m` (coarse 10-minute sampled EWMA)

and computes:
- `fair_value_sigma_5m`
- `fair_value_sigma_10m`
- `fair_value_deribit_iv` (same contract, volatility from Deribit mark IV)

### Runtime Guards (hard/soft)

- Hard forbid if Binance price feed stale: `BTC_STALE_FORBID_MS` (default 30s)
- Hard forbid if Chainlink oracle lag too high on chainlink-triggered path: `BTC_CHAINLINK_ORACLE_LAG_FORBID_MS` (default 2000ms)
- Orderbook-triggered path with high oracle lag skips report row append (FV may still publish)
- Hard forbid if strike is null
- Stop trading within `STOP_TRADING_BEFORE_EXPIRY_MS` (default 60s)
- Strategy also requires `confidence > MIN_CONFIDENCE`

### Confidence logic

Confidence is currently time-only:

```
timeBonus = min(1, (timeToExpiryMs / 60000) * MIN_CONFIDENCE)
confidence = max(MIN_CONFIDENCE, timeBonus)
```

---

## Report Pipeline

`fairValueUpdater` appends Redis-backed report rows; `marketRoundReport` converts rows into markdown + CSV under `takerbot/reports/`.

### CSV schema (current)

```text
iso_time
chainlink_ts
binance_ts
binance_redis_ts
fair_value_redis_ts
time_to_expiry_ms
time_to_expiry_sec
strike_price
chainlink_price
binance_btcusdc_price
annualized_sigma_5m
annualized_sigma_10m
fair_value_sigma_5m
fair_value_sigma_10m
fair_value_deribit_iv
yes_bid
yes_ask
no_bid
no_ask
f_sigma_5m
g_sigma_5m
f_minus_g_sigma_5m
trade_signal_sigma_5m
f_sigma_10m
g_sigma_10m
f_minus_g_sigma_10m
trade_signal_sigma_10m
f_deribit_iv
g_deribit_iv
f_minus_g_deribit_iv
trade_signal_deribit_iv
```

### Trade signal semantics

- `trade_signal_*` in `{1, 0, -1}`
  - `1`: buy signal
  - `-1`: short signal
  - `0`: no trade

Signals include:
- f/g threshold tests
- spread filter
- TTE filter (`> STOP_TRADING_BEFORE_EXPIRY_MS`)
- confidence gate
- sigma-regime filter

### Manual report generation

```bash
npm run takerbot:marketRoundReport -- --active-market
npm run takerbot:marketRoundReport -- --slug btc-updown-15m-1774851300
npm run takerbot:marketRoundReport -- --slug btc-updown-15m-1774851300 --force
```

---

## Backtest Tool (Current)

Script: `takerbot/tools/backtestReportSignals.ts`

Uses the new report schema and currently executes variant based on:
- `trade_signal_deribit_iv`
- `f_deribit_iv`, `g_deribit_iv`, `f_minus_g_deribit_iv`

Behavior:
- 1 share per signal
- independent long and short books
- cap per side via `--max-yes-shares` (max 20)
- hold to settlement
- settlement proxy: last `binance_btcusdc_price`, fallback `chainlink_price`
- additional runtime filters: TTE, spread, sigma regime (`annualized_sigma_5m`)

Run:

```bash
npm run takerbot:reportBacktest
node --import tsx/esm takerbot/tools/backtestReportSignals.ts --delta 0.05 --gamma 0.03 --max-yes-shares 20
```

---

## Tuning Parameters

From `takerbot/config/constants.ts`:

| Constant | Default | Description |
|---|---|---|
| `VOLATILITY_EWMA_LAMBDA` | `0.94` | EWMA decay factor |
| `VOLATILITY_MIN_TICKS` | `3` | Minimum samples before sigma is usable |
| `BTC_STALE_FORBID_MS` | `30_000` | Binance staleness hard-forbid |
| `BTC_CHAINLINK_ORACLE_LAG_FORBID_MS` | `2000` | Chainlink oracle-lag guard |
| `MIN_CONFIDENCE` | `0.18` | Confidence floor |
| `STOP_TRADING_BEFORE_EXPIRY_MS` | `60_000` | Stop-trading window before expiry |
| `EDGE_THRESHOLD` | `0.03` | Minimum trading edge |
| `POSITION_SIZE_USDC` | `50` | Notional per order |
| `MAX_EXPOSURE_USDC` | `200` | Max market exposure |
| `MIN_MARKET_LIQUIDITY` | `500` | Market selection liquidity floor |
| `MIN_TIME_TO_EXPIRY_MS` | `120_000` | Discovery lower bound |
| `MAX_TIME_TO_EXPIRY_MS` | `1_800_000` | Discovery upper bound |
| `MARKET_DISCOVERY_POLL_MS` | `60_000` | Discovery poll interval |

---

## Quick Start

### Prerequisites
- Node.js >= 20
- npm (or pnpm)
- local Redis (`redis://127.0.0.1:6379`)

### Install

```bash
npm install
```

### Env

```bash
cp deploy/.env.example .env
# set PRIVATE_KEY and DRY_RUN
```

### Run all processes (manual)

```bash
node --import tsx/esm takerbot/feeders/btcPriceFeeder.ts
node --import tsx/esm takerbot/feeders/chainlinkPriceFeeder.ts
node --import tsx/esm takerbot/feeders/marketDiscovery.ts
node --import tsx/esm takerbot/feeders/marketPriceFeeder.ts
node --import tsx/esm takerbot/updater/fairValueUpdater.ts
node --import tsx/esm takerbot/portfolio/portfolioTracker.ts
node --import tsx/esm takerbot/takerbot.ts
```

Or via PM2:

```bash
pm2 start takerbot/ecosystem.config.cjs
pm2 logs
```

---

## Redis Keys and Channels (Current)

| Key / Channel | Type | Written by | Read by |
|---|---|---|---|
| `feed:btc:price` | STRING | `btcPriceFeeder` | `fairValueUpdater`, diagnostics |
| `feed:btc:price:history` | LIST | `btcPriceFeeder` | diagnostics |
| `feed:btc:ws:last-received-sec` | STRING | `btcPriceFeeder` | diagnostics |
| `feed:chainlink:btc:price` | STRING | `chainlinkPriceFeeder` | `fairValueUpdater` |
| `feed:chainlink:btc:price:history` | LIST | `chainlinkPriceFeeder` | `fairValueUpdater`, diagnostics |
| `feed:market:{id}:orderbook` | STRING | `marketPriceFeeder` | `fairValueUpdater`, `takerbot` |
| `orderbook:full:{id}` | STRING | `marketPriceFeeder` | diagnostics |
| `feed:market:{id}:depth-pressure` | STRING | `marketPriceFeeder` | consumers of depth-pressure |
| `market:active-btc15m` | STRING | `marketDiscovery` | all (cold-start) |
| `market:info:{id}` | STRING | `marketDiscovery` | report tools |
| `market:info:slug:{slug}` | STRING | `marketDiscovery` | report tools |
| `market:report:rows:{id}` | LIST | `fairValueUpdater` | `marketRoundReport` |
| `fv:{id}` | STRING | `fairValueUpdater` | `takerbot` fallback |
| `position:{id}` | STRING | `takerbot` | `portfolioTracker` |
| `portfolio:snapshot` | STRING | `portfolioTracker` | diagnostics |
| `btc:price:updated` | CHANNEL | `btcPriceFeeder` | diagnostics |
| `chainlink:btc:price:updated` | CHANNEL | `chainlinkPriceFeeder` | `fairValueUpdater` |
| `market:orderbook:updated:{id}` | CHANNEL | `marketPriceFeeder` | `fairValueUpdater` |
| `market:depth-pressure:updated:{id}` | CHANNEL | `marketPriceFeeder` | depth-pressure consumers |
| `market:new-active-market` | CHANNEL | `marketDiscovery` | rotating processes |
| `fv:updated:{id}` | CHANNEL | `fairValueUpdater` | `takerbot` |
| `order:filled:{id}` | CHANNEL | `takerbot` | `portfolioTracker` |

---

## Directory Structure

```
takerbot/
├── config/
├── feeders/
├── updater/
├── strategy/
├── portfolio/
├── shared/
├── tools/
├── reports/
├── takerbot.ts
└── ecosystem.config.cjs
```

---

## Known Limitations

- Single-market strategy process (no parallel multi-market executor)
- No robust fill reconciliation loop (optimistic position updates)
- Strong dependency on Vatic strike availability
- Report `no_bid` / `no_ask` synthesized from yes-side book
- Redis report row cap at 5000 rows per market
