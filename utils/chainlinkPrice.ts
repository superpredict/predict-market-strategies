// npx tsx utils/chainlinkPrice.ts
import WebSocket from 'ws';

const WS_URL = 'wss://ws-live-data.polymarket.com';

function startPolymarketChainlinkBtcLogger(): void {
  console.log('🚀 Polymarket Chainlink BTC/USD Logger started...');
  console.log('Only monitoring BTC/USD (Chainlink source)\n');

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ✅ WebSocket connected`);

    // Subscribe to all Chainlink, but we will filter BTC/USD later
    const subscribeMsg = {
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: ""                    // subscribe all, filter later
        }
      ]
    };

    ws.send(JSON.stringify(subscribeMsg));
    console.log(`[${timestamp}] Subscribed to Chainlink. Filtering BTC/USD only...`);
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      const logTime = new Date().toISOString();

      if (
        message.topic === 'crypto_prices_chainlink' &&
        message.type === 'update' &&
        message.payload &&
        message.payload.symbol === 'btc/usd'          // ← Filter only BTC/USD
      ) {
        const payload = message.payload;
        const price = parseFloat(payload.value);
        const priceTime = new Date(payload.timestamp).toISOString();

        console.log(`[${logTime}] [Chainlink] BTC/USD Price: $${price.toLocaleString()}`);
        console.log(`          └─ Recorded at: ${priceTime}`);
        console.log('');   // empty line for clarity
      }
    } catch (error) {
      // ignore parse errors
    }
  });

  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] WebSocket error:`, error.message);
  });

  ws.on('close', () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] WebSocket closed. Reconnecting in 5 seconds...`);
    setTimeout(startPolymarketChainlinkBtcLogger, 5000);
  });
}

// Start the logger
startPolymarketChainlinkBtcLogger();