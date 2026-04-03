/**
 * TakerStrategy
 *
 * Extends the base Strategy class (src/core/strategy.ts) and adds a Redis
 * pub/sub subscription so it reacts to fair value changes in <50ms.
 *
 * Decision logic:
 *   BUY  when  marketAsk  <  FV - edgeThreshold  (market underpriced)
 *   SELL when  marketBid  >  FV + edgeThreshold  (market overpriced)
 *
 * Order type: FAK (Fill And Kill) — acts as a market order on Polymarket.
 * Position: capped by maxExposureUsdc to limit risk per market.
 *
 * Market rotation:
 *   Subscribes to  market:new-active-market  at startup so it hot-swaps
 *   to the next 15-min window without a process restart, exactly mirroring
 *   the approach used by marketPriceFeeder.
 *
 * The slow-tick (default 10 s) also polls Redis in case pub/sub messages
 * were missed, and handles clean-up near expiry.
 */

import { Strategy } from '@superpredict/ccxt';
import type { Exchange } from '@superpredict/ccxt';
import { OrderSide } from '@superpredict/ccxt';
import {
  MIN_CONFIDENCE,
  STOP_TRADING_BEFORE_EXPIRY_MS,
  STRATEGY_SLOW_TICK_MS,
  VERBOSE,
} from '../config/constants.js';
import { buildMarketConfigFromInfo } from '../config/markets.js';
import { closeRedis, getRedisClient, getSubscriberClient } from '../shared/redis.js';
import { getFairValue, getOrderbook, getPosition, setPosition } from '../shared/state.js';
import {
  REDIS_CHANNELS,
  type ActiveMarketInfo,
  type FairValue,
  type MarketConfig,
  type PortfolioPosition,
} from '../shared/types.js';

// ─── Strategy ─────────────────────────────────────────────────────────────────

export class TakerStrategy extends Strategy {
  private marketConfig: MarketConfig;
  private isProcessing = false;
  private lastProcessedFvTs = 0;

  private latencyStats: number[] = [];

  /** Tracks the currently-subscribed fair-value channel so we can unsubscribe on rotation. */
  private currentFvChannel: string | null = null;
  /** Bound handler reference so we can call sub.off() on rotation. */
  private fvMessageHandler: ((ch: string, msg: string) => void) | null = null;

  constructor(exchange: Exchange, config: MarketConfig) {
    super(exchange, config.marketId, {
      tickInterval: STRATEGY_SLOW_TICK_MS,
      maxPositionSize: config.maxExposureUsdc,
      verbose: VERBOSE,
    });
    this.marketConfig = config;
  }

  // ─── Start: add pub/sub on top of base tick loop ────────────────────────────

  override async start(): Promise<void> {
    await super.start();
    await this.subscribeToMarketRotation();
    await this.subscribeToFairValueUpdates();
    console.log(`[takerStrategy] started for market ${this.marketConfig.marketId}`);
  }

  // ─── Called on each slow tick (poll fallback) ────────────────────────────────

  override async onTick(): Promise<void> {
    const fv = await getFairValue(this.marketConfig.marketId);
    if (!fv) return;
    await this.evaluate(fv);
  }

  // ─── Market rotation: subscribe to new-active-market ────────────────────────

  private async subscribeToMarketRotation(): Promise<void> {
    const sub = getSubscriberClient();
    await sub.subscribe(REDIS_CHANNELS.newActiveMarket);

    sub.on('message', (channel: string, message: string) => {
      if (channel !== REDIS_CHANNELS.newActiveMarket) return;
      void (async () => {
        try {
          const info = JSON.parse(message) as ActiveMarketInfo;
          await this.switchMarket(info);
        } catch (err) {
          console.error('[takerStrategy] market rotation error:', err);
        }
      })();
    });

    console.log(`[takerStrategy] subscribed to ${REDIS_CHANNELS.newActiveMarket} for market rotation`);
  }

  // ─── Market rotation: hot-swap to a new market ───────────────────────────────

  private async switchMarket(info: ActiveMarketInfo): Promise<void> {
    if (info.conditionId === this.marketConfig.marketId) {
      console.log(`[takerStrategy] already on market ${info.conditionId.slice(0, 10)}…, skipping`);
      return;
    }

    console.log(
      `[takerStrategy] ↩ rotating ${this.marketConfig.marketId.slice(0, 10)}… → ` +
      `${info.conditionId.slice(0, 10)}… "${info.question}"`
    );

    // Build a fresh config from the incoming market info (trading params from constants)
    this.marketConfig = buildMarketConfigFromInfo(info);

    // Reset per-market state so the first evaluate() on the new market starts clean
    this.isProcessing = false;
    this.lastProcessedFvTs = 0;
    this.latencyStats = [];

    // Re-subscribe the fair-value channel for the new market
    await this.subscribeToFairValueUpdates();

    console.log(
      `[takerStrategy] now trading ${info.conditionId.slice(0, 10)}… ` +
      `exp=${info.endDate} strike=${info.strikePrice ?? 'N/A'}`
    );
  }

  // ─── Fast path: react to Redis pub/sub FV updates ───────────────────────────

  private async subscribeToFairValueUpdates(): Promise<void> {
    const sub = getSubscriberClient();

    // Unsubscribe from the previous market's channel before switching
    if (this.currentFvChannel && this.fvMessageHandler) {
      await sub.unsubscribe(this.currentFvChannel);
      sub.off('message', this.fvMessageHandler);
    }

    const channel = REDIS_CHANNELS.fairValueUpdated(this.marketConfig.marketId);
    this.currentFvChannel = channel;

    this.fvMessageHandler = (ch: string, message: string) => {
      if (ch !== channel) return;
      void (async () => {
        try {
          const fv = JSON.parse(message) as FairValue;
          await this.evaluate(fv);
        } catch (err) {
          console.error('[takerStrategy] pub/sub error:', err);
        }
      })();
    };

    await sub.subscribe(channel);
    sub.on('message', this.fvMessageHandler);

    console.log(`[takerStrategy] subscribed to ${channel}`);
  }

  // ─── Core decision logic ──────────────────────────────────────────────────────
private async evaluate(fv: FairValue): Promise<void> {
  if (this.isProcessing) return;           // prevent concurrent evaluations

  this.isProcessing = true;

  try {
    const fvReceivedAt = Date.now();
    const totalLatencyMs = fvReceivedAt - fv.publishedAt;

    const now = Date.now();
    const timeSinceLast = now - this.lastProcessedFvTs;

    // Skip if FV updates come too frequently (debounce)
    if (timeSinceLast < 50) {
      if (Math.random() < 0.08) {   
        console.log(`[takerStrategy] ⏭️ skipped FV (too frequent: ${timeSinceLast}ms ago)`);
      }
      return;
    }

    this.lastProcessedFvTs = now;

    console.log(`[latency] Total FV → Order: ${totalLatencyMs}ms | FV=${(fv.value*100).toFixed(2)}% conf=${(fv.confidence*100).toFixed(1)}%`);

    if (totalLatencyMs > 50) {
      console.warn(`[latency] ⚠️ SLOW: ${totalLatencyMs}ms (target < 50ms)`);
    }

    // Safety checks
    if (!this.shouldTrade(fv)) return;

    const ob = await getOrderbook(this.marketConfig.marketId);
    if (!ob) return;

    const { bestBid, bestAsk } = ob;
    const { value: fairValue, confidence } = fv;
    const { edgeThreshold, positionSizeUsdc, maxExposureUsdc, dryRun } = this.marketConfig;

    const position = await getPosition(this.marketConfig.marketId);
    const currentExposure = position ? Math.abs(position.size) * position.avgEntryPrice : 0;

    if (currentExposure >= maxExposureUsdc) {
      console.log(`[takerStrategy] max exposure reached ($${maxExposureUsdc}), skipping`);
      return;
    }

    const buyEdge = fairValue - bestAsk;
    const sellEdge = bestBid - fairValue;

    const logPrefix = `[takerStrategy] FV=${(fairValue * 100).toFixed(2)}% conf=${(confidence * 100).toFixed(0)}%`;

    if (buyEdge >= edgeThreshold) {
      console.log(`${logPrefix} BUY edge=${(buyEdge * 100).toFixed(2)}% ask=${bestAsk}`);
      await this.executeTakerOrder('Yes', OrderSide.BUY, bestAsk, positionSizeUsdc, dryRun);
    } else if (sellEdge >= edgeThreshold) {
      console.log(`${logPrefix} SELL edge=${(sellEdge * 100).toFixed(2)}% bid=${bestBid}`);
      await this.executeTakerOrder('Yes', OrderSide.SELL, bestBid, positionSizeUsdc, dryRun);
    } else {
      console.log(`${logPrefix} no edge (buyEdge=${(buyEdge * 100).toFixed(2)}% sellEdge=${(sellEdge * 100).toFixed(2)}%)`);
    }
  } finally {
    this.isProcessing = false;   
  }
}

  // ─── Checks ───────────────────────────────────────────────────────────────────
  private shouldTrade(fv: FairValue): boolean {
    const { timeToExpiryMs, confidence } = fv;
  
    if (timeToExpiryMs <= STOP_TRADING_BEFORE_EXPIRY_MS) {
      console.log(`[takerStrategy] too close to expiry (${Math.round(timeToExpiryMs / 1000)}s), halting`);
      return false;
    }
  
    if (confidence < MIN_CONFIDENCE) {
      console.log(`[takerStrategy] low confidence (${(confidence * 100).toFixed(1)}%) — skipping`);
      return false;
    }
  
    console.log(`[takerStrategy] ✅ OK to trade | conf=${(confidence * 100).toFixed(1)}% | tte=${Math.round(timeToExpiryMs / 1000)}s`);
    return true;
  }

  // ─── Order execution ─────────────────────────────────────────────────────────

  private async executeTakerOrder(
    outcome: string,
    side: OrderSide,
    price: number,
    positionSizeUsdc: number,
    dryRun: boolean
  ): Promise<void> {
    const tokenId =
      outcome === 'Yes'
        ? this.marketConfig.yesTokenId
        : this.marketConfig.noTokenId;

    // Calculate number of shares to trade (always positive)
    // We target ~positionSizeUsdc USDC notional value per trade
    const shares = positionSizeUsdc / price;

    if (dryRun) {
      console.log(
        `[takerStrategy] DRY_RUN ${side} ${shares.toFixed(2)} shares of ${outcome} @ ${price}`
      );
      return;
    }

    try {
      const order = await this.placeOrder(outcome, side, price, shares, tokenId);
      if (!order) return;

      console.log(
        `[takerStrategy] order placed id=${order.id} ${side} ${shares.toFixed(2)} @ ${price}`
      );

      await this.updatePosition(outcome, side, price, shares);
      await this.publishFillEvent(outcome, side, price, shares);
    } catch (err) {
      console.error(`[takerStrategy] order failed:`, err);
    }
  }

  private async publishFillEvent(
    outcome: string,
    side: OrderSide,
    price: number,
    shares: number
  ): Promise<void> {
    const fillEvent = {
      marketId: this.marketConfig.marketId,
      outcome,
      side: side === OrderSide.BUY ? 'buy' : 'sell',
      price,
      shares,
      ts: Date.now(),
    };
    const redis = getRedisClient();
    await redis.publish(
      REDIS_CHANNELS.orderFilled(this.marketConfig.marketId),
      JSON.stringify(fillEvent)
    );
  }

  // ─── Position tracking ────────────────────────────────────────────────────────

  private async updatePosition(
    outcome: string,
    side: OrderSide,
    price: number,
    shares: number
  ): Promise<void> {
    const existing = await getPosition(this.marketConfig.marketId);

    let pos: PortfolioPosition;

    if (!existing) {
      pos = {
        marketId: this.marketConfig.marketId,
        outcome,
        size: side === OrderSide.BUY ? shares : -shares,
        avgEntryPrice: price,
        currentPrice: price,
        unrealizedPnl: 0,
        realizedPnl: 0,
        ts: Date.now(),
      };
    } else {
      const newSize = existing.size + (side === OrderSide.BUY ? shares : -shares);
      const newAvg =
        newSize !== 0
          ? side === OrderSide.BUY
            ? (existing.avgEntryPrice * Math.abs(existing.size) + price * shares) /
              (Math.abs(existing.size) + shares)
            : existing.avgEntryPrice // SELL does not change average entry cost
          : 0;

      pos = {
        ...existing,
        size: newSize,
        avgEntryPrice: newAvg,
        currentPrice: price,
        ts: Date.now(),
      };
    }

    await setPosition(pos);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  override async stop(): Promise<void> {
    await super.stop();
    await closeRedis();
    console.log(`[takerStrategy] stopped for market ${this.marketConfig.marketId}`);
  }
}
