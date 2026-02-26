/**
 * Token bucket rate limiter for external API calls.
 * Each data adapter gets its own limiter configured to the provider's limits.
 */

export interface RateLimiterOptions {
  /** Maximum tokens in the bucket */
  maxTokens: number;
  /** Tokens added per interval */
  refillRate: number;
  /** Refill interval in milliseconds */
  refillIntervalMs: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly options: RateLimiterOptions;
  private waitQueue: Array<{ resolve: () => void }> = [];

  constructor(options: RateLimiterOptions) {
    this.options = options;
    this.tokens = options.maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Acquire a token. Blocks until a token is available.
   * Returns a promise that resolves when the request can proceed.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve });
      this.scheduleRefill();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd =
      Math.floor(elapsed / this.options.refillIntervalMs) *
      this.options.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.tokens + tokensToAdd, this.options.maxTokens);
      this.lastRefillTime = now;

      // Process waiting requests
      while (this.waitQueue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const next = this.waitQueue.shift();
        next?.resolve();
      }
    }
  }

  private refillTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRefill(): void {
    if (this.refillTimer) return;
    this.refillTimer = setTimeout(() => {
      this.refillTimer = null;
      this.refill();
      if (this.waitQueue.length > 0) {
        this.scheduleRefill();
      }
    }, this.options.refillIntervalMs);
  }

  /** Current available tokens (for monitoring) */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /** Pending requests in queue (for monitoring) */
  getQueueLength(): number {
    return this.waitQueue.length;
  }
}

/**
 * Pre-configured rate limiters for known data providers.
 */
export const PROVIDER_LIMITS: Record<string, RateLimiterOptions> = {
  polygon: {
    maxTokens: 5,
    refillRate: 5,
    refillIntervalMs: 60000, // 5 req/min for free tier
  },
  iex: {
    maxTokens: 100,
    refillRate: 100,
    refillIntervalMs: 1000, // 100 req/sec
  },
  alphaVantage: {
    maxTokens: 5,
    refillRate: 5,
    refillIntervalMs: 60000, // 5 req/min free tier
  },
  newsapi: {
    maxTokens: 100,
    refillRate: 100,
    refillIntervalMs: 86400000, // 100 req/day free tier
  },
  fred: {
    maxTokens: 120,
    refillRate: 120,
    refillIntervalMs: 60000, // 120 req/min
  },
};
