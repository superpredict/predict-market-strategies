# Report backtest compare: variants (a)/(b)/(c)

- generated: 2026-04-28T09:02:14.934Z
- output: `takerbot/reports/backtest-fg-compare-2026-04-28T09-02-14-908Z.md`
- source reports: all `*.csv` in reports dir (excluding names starting with `backtest-`)

## Parameters used in this run

- `δ` (delta): **0.05**
- `γ` (gamma): **0.03**
- min confidence: **0.18** (currently informational; signal already pre-filtered in report)
- min time-to-expiry (ms): **60000** (must be strictly greater than this)
- max YES spread (ask−bid): **0.08**
- max cumulative shares per side (long cap / short cap): **20**
- sigma median window: **31**, ratio band: **[0.35, 3.5]× median**
- reports directory: `/Users/leo_1/Documents/GitHub/superpredict/predict-market-strategies/takerbot/reports`

## Variant Comparison

| variant | signal column | long PnL | short PnL | combined PnL | long win rate | short win rate | #L adds | #S adds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
(a) sigma_5m | `trade_signal_sigma_5m` | 10.580000 | -3.270000 | 7.310000 | 66.67% | 33.33% | 45 | 15
(b) sigma_10m | `trade_signal_sigma_10m` | 12.950000 | -0.190000 | 12.760000 | 100.00% | 0.00% | 20 | 1
(c) deribit_iv | `trade_signal_deribit_iv` | 8.340000 | -13.840000 | -5.500000 | 33.33% | 0.00% | 51 | 40

Ranking by combined PnL:
1. (b) sigma_10m: **12.760000**
2. (a) sigma_5m: **7.310000**
3. (c) deribit_iv: **-5.500000**

## Per-Market Compare (combined PnL)

| source CSV | payoff | (a) sigma_5m | (b) sigma_10m | (c) deribit_iv |
| --- | ---: | ---: | ---: | ---: |
`btc-updown-15m-1777363200.csv` | 0 | 0.000000 | 0.000000 | -0.570000
`btc-updown-15m-1777364100.csv` | 1 | 3.790000 | 0.000000 | -6.410000
`btc-updown-15m-1777365000.csv` | 0 | -4.270000 | 0.000000 | -5.720000
`btc-updown-15m-1777365900.csv` | 1 | 7.790000 | 12.760000 | 7.200000

## Variant (a) — sigma_5m

- signal column: `trade_signal_sigma_5m`
- f/g/f-g: `f_sigma_5m` / `g_sigma_5m` / `f_minus_g_sigma_5m`
- long markets with fills: **3**
- short markets with fills: **3**
- long total PnL: **10.580000**
- short total PnL: **-3.270000**
- combined PnL: **7.310000**
- long win rate: **66.67%**
- short win rate: **33.33%**
- total long adds: **45**
- total short adds: **15**

| source CSV | YES payoff | long PnL | #L | short PnL | #S | combined PnL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
`btc-updown-15m-1777363200.csv` | 0 | — | 0 | — | 0 | 0.000000
`btc-updown-15m-1777364100.csv` | 1 | 3.990000 | 14 | -0.200000 | 1 | 3.790000
`btc-updown-15m-1777365000.csv` | 0 | -5.690000 | 11 | 1.420000 | 8 | -4.270000
`btc-updown-15m-1777365900.csv` | 1 | 12.280000 | 20 | -4.490000 | 6 | 7.790000

## Variant (b) — sigma_10m

- signal column: `trade_signal_sigma_10m`
- f/g/f-g: `f_sigma_10m` / `g_sigma_10m` / `f_minus_g_sigma_10m`
- long markets with fills: **1**
- short markets with fills: **1**
- long total PnL: **12.950000**
- short total PnL: **-0.190000**
- combined PnL: **12.760000**
- long win rate: **100.00%**
- short win rate: **0.00%**
- total long adds: **20**
- total short adds: **1**

| source CSV | YES payoff | long PnL | #L | short PnL | #S | combined PnL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
`btc-updown-15m-1777363200.csv` | 0 | — | 0 | — | 0 | 0.000000
`btc-updown-15m-1777364100.csv` | 1 | — | 0 | — | 0 | 0.000000
`btc-updown-15m-1777365000.csv` | 0 | — | 0 | — | 0 | 0.000000
`btc-updown-15m-1777365900.csv` | 1 | 12.950000 | 20 | -0.190000 | 1 | 12.760000

## Variant (c) — deribit_iv

- signal column: `trade_signal_deribit_iv`
- f/g/f-g: `f_deribit_iv` / `g_deribit_iv` / `f_minus_g_deribit_iv`
- long markets with fills: **3**
- short markets with fills: **2**
- long total PnL: **8.340000**
- short total PnL: **-13.840000**
- combined PnL: **-5.500000**
- long win rate: **33.33%**
- short win rate: **0.00%**
- total long adds: **51**
- total short adds: **40**

| source CSV | YES payoff | long PnL | #L | short PnL | #S | combined PnL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
`btc-updown-15m-1777363200.csv` | 0 | -0.570000 | 11 | — | 0 | -0.570000
`btc-updown-15m-1777364100.csv` | 1 | — | 0 | -6.410000 | 20 | -6.410000
`btc-updown-15m-1777365000.csv` | 0 | -5.720000 | 20 | — | 0 | -5.720000
`btc-updown-15m-1777365900.csv` | 1 | 14.630000 | 20 | -7.430000 | 20 | 7.200000

