# takerbot Full Execution Example Flow (Assumed Scenario)

Date assumption: 2025-07-15 14:00:00 UTC  
Current BTC spot price (Binance mid): $96,800  
Polymarket market: "Will Bitcoin be above $97,000 at 14:15 UTC?"  
marketId: 0xabc123...def456  
yesTokenId: 1234567890123456789012345678901234567890  
Expiry: 14:15:00 UTC (15 minutes remaining)  
Current Yes orderbook: best bid 0.432 / best ask 0.448 / mid ≈ 0.440

System parameters:
- EDGE_THRESHOLD     = 0.03 (3%)
- POSITION_SIZE_USDC = 50
- FV_SCALE           = 5
- MIN_CONFIDENCE     = 0.4
- STOP_TRADING_BEFORE_EXPIRY_MS = 90,000 ms

## Step 1 – btcPriceFeeder receives Binance bookTicker update
Time: t=0s  
Received:
```json
{
  "b": "96800.50",
  "a": "96801.20"
}
```
mid price = (96800.50 + 96801.20) / 2 = 96800.85

Actions:
- SET feed:btc:price (EX 60)
- PUBLISH btc:price:updated

Terminal output:
```
[btcPriceFeeder] BTC $96800.85  bid=96800.50 ask=96801.20
```

## Step 2 – fairValueUpdater receives price update and computes FV
Time: t≈0.1s  
Fetches latest orderbook:
bestBid: 0.432, bestAsk: 0.448

Calculation:
```
relativeDistance = (96800.85 - 97000) / 97000 ≈ -0.01257
FV = clamp(0.5 + (-0.01257) × 5, 0.05, 0.95) ≈ 0.437
```

confidence ≈ 0.56 (data freshness + time remaining)

Actions:
- SET fv:0xabc123... → value=0.437, confidence=0.56, ...
- PUBLISH fv:updated:0xabc123...

Terminal output:
```
[fairValueUpdater] FV=43.70% conf=56% btc=$96800.85 tte=900s
```

## Step 3 – takerStrategy first evaluation (no edge)
Time: t≈0.15s  
Received FV = 0.437

Calculation:
```
buyEdge  = 0.437 - 0.448 = -0.011  < 0.03 → no buy
sellEdge = 0.432 - 0.437 = -0.005  < 0.03 → no sell
```

Terminal output:
```
[takerStrategy] FV=43.70% conf=56% no edge (buyEdge=-1.10% sellEdge=-0.50%)
```

## Step 4 – BTC price jumps to $97,350
Time: t=2s  
btcPriceFeeder publishes again:
price: 97350.2

fairValueUpdater recalculates:
```
relativeDistance ≈ +0.00361
FV = 0.5 + 0.00361 × 5 ≈ 0.518
```

Actions:
- SET & PUBLISH new FV = 0.518, conf≈0.95

Terminal output:
```
[fairValueUpdater] FV=51.80% conf=95% btc=$97350.20 tte=898s
```

## Step 5 – takerStrategy second evaluation (buy edge detected)
Time: t≈2.1s  
Received FV = 0.518

Calculation:
```
buyEdge = 0.518 - 0.448 = 0.07  > 0.03 → edge found!
```

Decision:
- BUY Yes @ 0.448
- shares = 50 / 0.448 ≈ 111.61

If dryRun = true:
Terminal output:
```
[takerStrategy] DRY_RUN BUY 111.61 shares of Yes @ 0.448
```

If dryRun = false and order succeeds:
- Calls Polymarket.placeOrder()
- Updates position (Redis key: position:0xabc123...)
  size: 111.61, avgEntryPrice: 0.448, ...

## Step 6 – portfolioTracker receives update and prints
Terminal output:
```
[portfolioTracker] 0xabc123... size=111.61 avg=0.448 unrealizedPnl=$0.0000 realizedPnl=$0.0000
```

## Common Startup Commands

```sh
# Debug mode (recommended for testing)
tsx takerbot/feeders/btcPriceFeeder.ts
tsx takerbot/feeders/marketPriceFeeder.ts --marketid=0xabc... --tokenid=12345...
tsx takerbot/updater/fairValueUpdater.ts --marketid=0xabc... --strike=97000
tsx takerbot/takerbot.ts --marketid=0xabc...
tsx takerbot/portfolio/portfolioTracker.ts

# Start everything with PM2 (using ecosystem.config.cjs)
pm2 start takerbot/ecosystem.config.cjs

# Production mode (disable dry run)
export DRY_RUN=false
export PRIVATE_KEY=0x...
pm2 start takerbot/ecosystem.config.cjs --env production
pm2 save
pm2 startup   # auto-start on boot
```
