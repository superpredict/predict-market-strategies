import type { ChainlinkBtcPriceFeed } from './types.js';

export interface PriceTick {
  price: number;
  timestampMs: number;
}

/**
 * Streaming EWMA volatility estimator that keeps sigma in per-second units.
 *
 * Variance update:
 *   sigma^2_t = lambda * sigma^2_{t-1} + (1 - lambda) * (r_t^2 / dt)
 *
 * where:
 *   r_t = ln(S_t / S_{t-1})
 *   dt  = elapsed time in seconds
 */
export class EWMAVolatility {
  private readonly lambda: number;
  private lastPrice: number | null = null;
  private lastTimestampMs: number | null = null;
  private variance = 0;
  private initialized = false;

  constructor({ lambda }: { lambda: number }) {
    this.lambda = lambda;
  }

  update(price: number, timestampMs: number): number {
    if (this.lastPrice === null || this.lastTimestampMs === null) {
      this.lastPrice = price;
      this.lastTimestampMs = timestampMs;
      return 0;
    }

    const logReturn = Math.log(price / this.lastPrice);
    const dtSeconds = Math.max((timestampMs - this.lastTimestampMs) / 1000, 0.001);
    const variancePerSecondObservation = (logReturn * logReturn) / dtSeconds;

    if (!this.initialized) {
      this.variance = variancePerSecondObservation;
      this.initialized = true;
    } else {
      this.variance =
        this.lambda * this.variance + (1 - this.lambda) * variancePerSecondObservation;
    }

    this.lastPrice = price;
    this.lastTimestampMs = timestampMs;
    return Math.sqrt(this.variance);
  }

  warmFromChainlinkHistory(history: ChainlinkBtcPriceFeed[]): number {
    const ordered = [...history].sort((a, b) => a.chainlinkTs - b.chainlinkTs);
    let sigma = this.getVolatility();

    for (const tick of ordered) {
      sigma = this.update(tick.price, tick.chainlinkTs);
    }

    return sigma;
  }

  getVolatility(): number {
    return this.initialized ? Math.sqrt(this.variance) : 0;
  }
}
