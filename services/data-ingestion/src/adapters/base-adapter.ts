/**
 * Abstract base class for all data source adapters.
 *
 * Provides unified infrastructure for rate limiting, circuit breaking,
 * retry with backoff, structured logging, and data validation hooks.
 * Every concrete adapter (Polygon, IEX, Alpha Vantage, etc.) extends this.
 */

import fetch, { Response, RequestInit } from 'node-fetch';
import { RateLimiter, PROVIDER_LIMITS, RateLimiterOptions } from '../../../../shared/src/utils/rate-limiter';
import { withRetry, CircuitBreaker, RetryOptions, CircuitBreakerOptions } from '../../../../shared/src/utils/retry';
import { Logger } from '../../../../shared/src/utils/logger';

/** Configuration passed to every adapter at construction */
export interface AdapterConfig {
  /** Provider name, must match a key in PROVIDER_LIMITS (or override rateLimiter) */
  providerName: string;
  /** API key / auth token for the upstream provider */
  apiKey: string;
  /** Optional base URL override (useful for testing against mocks) */
  baseUrl?: string;
  /** Override default retry behaviour */
  retryOptions?: Partial<RetryOptions>;
  /** Override default circuit breaker behaviour */
  circuitBreakerOptions?: Partial<CircuitBreakerOptions>;
  /** Override default rate limiter config (otherwise looked up from PROVIDER_LIMITS) */
  rateLimiterOptions?: RateLimiterOptions;
}

/** The shape returned from every validated fetch */
export interface AdapterResponse<T> {
  data: T;
  /** Millis the upstream call took (excluding queue/retry time) */
  latencyMs: number;
  /** How many times the request was retried before succeeding */
  retries: number;
  /** ISO-8601 timestamp when the upstream response was received */
  receivedAt: string;
}

/** Errors surfaced by the adapter layer carry provider context */
export class AdapterError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'AdapterError';
  }
}

export abstract class BaseAdapter {
  protected readonly logger: Logger;
  protected readonly rateLimiter: RateLimiter;
  protected readonly circuitBreaker: CircuitBreaker;
  protected readonly config: AdapterConfig;
  private readonly retryOpts: Partial<RetryOptions>;

  constructor(config: AdapterConfig) {
    this.config = config;

    this.logger = new Logger(`adapter:${config.providerName}`);

    // Use provider-specific rate limits or caller-supplied overrides
    const rlOptions =
      config.rateLimiterOptions ??
      PROVIDER_LIMITS[config.providerName] ??
      { maxTokens: 10, refillRate: 10, refillIntervalMs: 1000 };
    this.rateLimiter = new RateLimiter(rlOptions);

    this.circuitBreaker = new CircuitBreaker(
      config.providerName,
      config.circuitBreakerOptions,
    );

    this.retryOpts = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn('Retrying request', {
          attempt,
          delayMs,
          error: error.message,
        });
      },
      ...config.retryOptions,
    };

    this.logger.info('Adapter initialised', {
      provider: config.providerName,
      baseUrl: this.getBaseUrl(),
    });
  }

  /** Subclasses must declare a base URL */
  protected abstract getBaseUrl(): string;

  /**
   * Optional validation hook.  Subclasses override this to inspect raw
   * upstream response payloads and log / reject inconsistencies before
   * the data reaches normalisation.
   *
   * Return `true` if the payload is acceptable, `false` to discard it.
   */
  protected validate(_raw: unknown): boolean {
    return true;
  }

  // -------------------------------------------------------------------
  // Core HTTP helpers
  // -------------------------------------------------------------------

  /**
   * The main workhorse.  Every concrete adapter method should go through
   * this to get rate-limiting, circuit breaking, retries, and logging
   * for free.
   */
  protected async fetchWithResilience<T>(
    path: string,
    init?: RequestInit,
    queryParams?: Record<string, string>,
  ): Promise<AdapterResponse<T>> {
    const url = this.buildUrl(path, queryParams);
    let retries = 0;

    const result = await withRetry(
      async () => {
        // 1. Respect the provider rate limit
        await this.rateLimiter.acquire();

        // 2. Go through the circuit breaker
        return this.circuitBreaker.execute(async () => {
          const start = Date.now();

          this.logger.debug('Outbound request', {
            url,
            method: init?.method ?? 'GET',
          });

          const response = await fetch(url, {
            ...init,
            headers: {
              'Accept': 'application/json',
              ...this.getAuthHeaders(),
              ...init?.headers,
            },
          });

          const latencyMs = Date.now() - start;

          if (!response.ok) {
            const body = await response.text().catch(() => '');
            const retryable = this.isRetryable(response.status);

            this.logger.warn('Upstream error response', {
              url,
              status: response.status,
              body: body.slice(0, 500),
              retryable,
            });

            throw new AdapterError(
              this.config.providerName,
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              body,
              retryable,
            );
          }

          const data = (await response.json()) as T;

          // Run the subclass validation hook
          if (!this.validate(data)) {
            this.logger.warn('Validation rejected upstream payload', {
              url,
              provider: this.config.providerName,
            });
            throw new AdapterError(
              this.config.providerName,
              'Payload failed validation',
              response.status,
              undefined,
              false,
            );
          }

          this.logger.debug('Response received', {
            url,
            status: response.status,
            latencyMs,
          });

          return {
            data,
            latencyMs,
            retries,
            receivedAt: new Date().toISOString(),
          } as AdapterResponse<T>;
        });
      },
      {
        ...this.retryOpts,
        onRetry: (error, attempt, delayMs) => {
          retries = attempt;
          this.retryOpts.onRetry?.(error, attempt, delayMs);
        },
      },
    );

    return result;
  }

  /**
   * Build a full URL from the base URL, a relative path, and optional
   * query parameters.
   */
  protected buildUrl(
    path: string,
    queryParams?: Record<string, string>,
  ): string {
    const base = this.config.baseUrl ?? this.getBaseUrl();
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Default auth header uses Bearer token.
   * Subclasses can override for query-param-based auth (Alpha Vantage).
   */
  protected getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  /**
   * Decide which HTTP status codes are worth retrying.
   * 429 (rate limited) and 5xx are retryable; 4xx generally are not.
   */
  protected isRetryable(status: number): boolean {
    if (status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  /**
   * Parse a Retry-After header value into milliseconds.
   */
  protected parseRetryAfter(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  /** Health check — concrete adapters should override for richer checks */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.rateLimiter.acquire();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  /** Expose circuit breaker state for monitoring */
  getCircuitState() {
    return this.circuitBreaker.getState();
  }

  /** Expose rate limiter metrics for monitoring */
  getRateLimiterMetrics() {
    return {
      availableTokens: this.rateLimiter.getAvailableTokens(),
      queueLength: this.rateLimiter.getQueueLength(),
    };
  }
}
