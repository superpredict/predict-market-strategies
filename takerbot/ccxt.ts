/**
 * ccxt.pro probe — prints each watchTicker payload as returned (no transforms).
 *
 * Run: yarn takerbot:ccxt
 * Optional: SYMBOL=ETH/USDC yarn takerbot:ccxt
 */

import dotenv from 'dotenv';
import ccxt from 'ccxt';

dotenv.config();

const SYMBOL = process.env['SYMBOL'] ?? 'BTC/USDC';

const exchange = new (ccxt as any).pro.binance({
  enableRateLimit: true,
  options: {
    defaultType: 'spot',
  },
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await exchange.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log(`[ccxt] ccxt.pro binance watchTicker(${SYMBOL}) — raw console.log per tick`);

while (!shuttingDown) {
  try {
    const ticker = await exchange.watchTicker(SYMBOL);
    console.log(ticker);
  } catch (err) {
    if (shuttingDown) break;
    console.error('[ccxt] watchTicker error:', err);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
