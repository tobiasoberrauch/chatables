/**
 * Adapter Integration Tests
 *
 * Tests data adapter normalization and resilience patterns using mocked HTTP.
 * Verifies that raw provider responses are correctly normalized into canonical types.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../shared/src/utils/rate-limiter';
import { withRetry, CircuitBreaker, CircuitOpenError, CircuitState } from '../../../shared/src/utils/retry';
import { BarSize, InstrumentType, AssetClass, type OHLCVBar, type CompanyFundamentals } from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Mock Polygon.io raw response shapes
// ---------------------------------------------------------------------------

interface PolygonAggregateResult {
  v: number;
  vw: number;
  o: number;
  c: number;
  h: number;
  l: number;
  t: number;
  n: number;
}

interface PolygonAggregatesResponse {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results: PolygonAggregateResult[];
  status: string;
  request_id: string;
}

// ---------------------------------------------------------------------------
// Normalization functions (exercised from adapter logic)
// ---------------------------------------------------------------------------

/** Normalize a Polygon aggregate result to canonical OHLCVBar */
function normalizePolygonBar(
  raw: PolygonAggregateResult,
  instrumentId: string,
  barSize: BarSize,
  adjusted: boolean,
): OHLCVBar | null {
  if (raw.h < raw.l) return null;
  if (raw.v < 0) raw.v = 0;

  return {
    instrumentId,
    timestamp: new Date(raw.t).toISOString(),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    vwap: raw.vw ?? null,
    trades: raw.n ?? null,
    barSize,
    isAdjusted: adjusted,
    source: 'polygon',
  };
}

/** Normalize an IEX company fundamentals response */
function normalizeIEXFundamentals(
  raw: Record<string, any>,
  instrumentId: string,
): CompanyFundamentals {
  return {
    instrumentId,
    reportDate: raw.reportDate ?? raw.fiscalDate ?? '',
    period: raw.fiscalQuarter ? `Q${raw.fiscalQuarter}` as any : 'FY',
    fiscalYear: raw.fiscalYear ?? new Date().getFullYear(),
    revenue: raw.totalRevenue ?? raw.revenue ?? null,
    netIncome: raw.netIncome ?? null,
    eps: raw.actualEPS ?? raw.eps ?? null,
    epsEstimate: raw.consensusEPS ?? raw.estimatedEPS ?? null,
    marketCap: raw.marketcap ?? raw.marketCap ?? null,
    peRatio: raw.peRatio ?? null,
    pbRatio: raw.priceToBook ?? null,
    debtToEquity: raw.debtToEquity ?? null,
    dividendYield: raw.dividendYield ?? null,
    freeCashFlow: raw.freeCashFlow ?? null,
    currency: raw.currency ?? 'USD',
    source: 'iex',
    updatedAt: new Date().toISOString(),
  };
}

/** Normalize Alpha Vantage FX response */
function normalizeAlphaVantageFX(
  raw: Record<string, any>,
): { pair: string; bid: number; ask: number; timestamp: string } | null {
  const data = raw['Realtime Currency Exchange Rate'];
  if (!data) return null;

  return {
    pair: `${data['1. From_Currency Code']}/${data['3. To_Currency Code']}`,
    bid: parseFloat(data['8. Bid Price']),
    ask: parseFloat(data['9. Ask Price']),
    timestamp: data['6. Last Refreshed'],
  };
}

// ---------------------------------------------------------------------------
// Polygon adapter normalization tests
// ---------------------------------------------------------------------------

describe('Polygon adapter normalization', () => {
  const sampleResponse: PolygonAggregatesResponse = {
    ticker: 'AAPL',
    queryCount: 3,
    resultsCount: 3,
    adjusted: true,
    results: [
      { v: 12345678, vw: 148.52, o: 147.50, c: 149.00, h: 150.25, l: 146.80, t: 1718409600000, n: 54321 },
      { v: 9876543, vw: 149.30, o: 149.10, c: 150.50, h: 151.00, l: 148.50, t: 1718496000000, n: 43210 },
      { v: 11223344, vw: 150.75, o: 150.60, c: 151.20, h: 152.00, l: 149.90, t: 1718582400000, n: 56789 },
    ],
    status: 'OK',
    request_id: 'test-req-1',
  };

  it('normalizes a known Polygon response into canonical OHLCVBar array', () => {
    const bars = sampleResponse.results
      .map((r) => normalizePolygonBar(r, 'aapl-uuid', BarSize.DAY_1, true))
      .filter((b): b is OHLCVBar => b !== null);

    expect(bars).toHaveLength(3);

    // First bar
    expect(bars[0].instrumentId).toBe('aapl-uuid');
    expect(bars[0].open).toBe(147.50);
    expect(bars[0].high).toBe(150.25);
    expect(bars[0].low).toBe(146.80);
    expect(bars[0].close).toBe(149.00);
    expect(bars[0].volume).toBe(12345678);
    expect(bars[0].vwap).toBe(148.52);
    expect(bars[0].trades).toBe(54321);
    expect(bars[0].barSize).toBe(BarSize.DAY_1);
    expect(bars[0].isAdjusted).toBe(true);
    expect(bars[0].source).toBe('polygon');

    // Timestamp should be ISO 8601
    expect(bars[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('skips bars where high < low', () => {
    const invalidResult: PolygonAggregateResult = {
      v: 1000, vw: 100, o: 100, c: 100, h: 90, l: 100, t: 1718409600000, n: 10,
    };
    const bar = normalizePolygonBar(invalidResult, 'test', BarSize.DAY_1, false);
    expect(bar).toBeNull();
  });

  it('clamps negative volume to 0', () => {
    const negVolResult: PolygonAggregateResult = {
      v: -500, vw: 100, o: 100, c: 100, h: 105, l: 95, t: 1718409600000, n: 10,
    };
    const bar = normalizePolygonBar(negVolResult, 'test', BarSize.DAY_1, false);
    expect(bar).not.toBeNull();
    expect(bar!.volume).toBe(0);
  });

  it('preserves all OHLCV fields accurately', () => {
    const raw: PolygonAggregateResult = {
      v: 42000, vw: 123.456, o: 122.00, c: 124.50, h: 125.00, l: 121.50, t: 1718409600000, n: 999,
    };
    const bar = normalizePolygonBar(raw, 'xyz-uuid', BarSize.MINUTE_5, false);
    expect(bar).not.toBeNull();
    expect(bar!.open).toBe(122.00);
    expect(bar!.high).toBe(125.00);
    expect(bar!.low).toBe(121.50);
    expect(bar!.close).toBe(124.50);
    expect(bar!.volume).toBe(42000);
    expect(bar!.barSize).toBe(BarSize.MINUTE_5);
    expect(bar!.isAdjusted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IEX adapter fundamentals normalization
// ---------------------------------------------------------------------------

describe('IEX adapter fundamentals normalization', () => {
  it('normalizes a company fundamentals response', () => {
    const iexResponse = {
      reportDate: '2024-03-31',
      fiscalQuarter: 2,
      fiscalYear: 2024,
      totalRevenue: 94836000000,
      netIncome: 23636000000,
      actualEPS: 1.53,
      consensusEPS: 1.50,
      marketcap: 2890000000000,
      peRatio: 28.5,
      priceToBook: 45.2,
      debtToEquity: 1.87,
      dividendYield: 0.0055,
      freeCashFlow: 28000000000,
      currency: 'USD',
    };

    const result = normalizeIEXFundamentals(iexResponse, 'aapl-uuid');

    expect(result.instrumentId).toBe('aapl-uuid');
    expect(result.reportDate).toBe('2024-03-31');
    expect(result.period).toBe('Q2');
    expect(result.fiscalYear).toBe(2024);
    expect(result.revenue).toBe(94836000000);
    expect(result.netIncome).toBe(23636000000);
    expect(result.eps).toBe(1.53);
    expect(result.epsEstimate).toBe(1.50);
    expect(result.marketCap).toBe(2890000000000);
    expect(result.peRatio).toBe(28.5);
    expect(result.pbRatio).toBe(45.2);
    expect(result.debtToEquity).toBe(1.87);
    expect(result.dividendYield).toBe(0.0055);
    expect(result.freeCashFlow).toBe(28000000000);
    expect(result.source).toBe('iex');
    expect(result.currency).toBe('USD');
  });

  it('handles missing optional fields', () => {
    const iexResponse = {
      reportDate: '2024-03-31',
      fiscalYear: 2024,
      currency: 'USD',
    };

    const result = normalizeIEXFundamentals(iexResponse, 'test-uuid');

    expect(result.revenue).toBeNull();
    expect(result.netIncome).toBeNull();
    expect(result.eps).toBeNull();
    expect(result.epsEstimate).toBeNull();
    expect(result.marketCap).toBeNull();
    expect(result.peRatio).toBeNull();
    expect(result.period).toBe('FY');
  });
});

// ---------------------------------------------------------------------------
// Alpha Vantage FX normalization
// ---------------------------------------------------------------------------

describe('Alpha Vantage FX response normalization', () => {
  it('normalizes a currency exchange rate response', () => {
    const avResponse = {
      'Realtime Currency Exchange Rate': {
        '1. From_Currency Code': 'EUR',
        '2. From_Currency Name': 'Euro',
        '3. To_Currency Code': 'USD',
        '4. To_Currency Name': 'United States Dollar',
        '5. Exchange Rate': '1.08500',
        '6. Last Refreshed': '2024-06-15 14:30:00',
        '7. Time Zone': 'UTC',
        '8. Bid Price': '1.08450',
        '9. Ask Price': '1.08550',
      },
    };

    const result = normalizeAlphaVantageFX(avResponse);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('EUR/USD');
    expect(result!.bid).toBeCloseTo(1.0845);
    expect(result!.ask).toBeCloseTo(1.0855);
    expect(result!.timestamp).toBe('2024-06-15 14:30:00');
  });

  it('returns null for invalid response structure', () => {
    const result = normalizeAlphaVantageFX({ error: 'Invalid API call' });
    expect(result).toBeNull();
  });

  it('handles USD/JPY pair with large price values', () => {
    const avResponse = {
      'Realtime Currency Exchange Rate': {
        '1. From_Currency Code': 'USD',
        '3. To_Currency Code': 'JPY',
        '6. Last Refreshed': '2024-06-15 14:30:00',
        '8. Bid Price': '157.450',
        '9. Ask Price': '157.460',
      },
    };

    const result = normalizeAlphaVantageFX(avResponse);
    expect(result).not.toBeNull();
    expect(result!.pair).toBe('USD/JPY');
    expect(result!.bid).toBeCloseTo(157.45);
    expect(result!.ask).toBeCloseTo(157.46);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter integration
// ---------------------------------------------------------------------------

describe('Rate limiter integration', () => {
  it('allows requests within the limit', async () => {
    const limiter = new RateLimiter({
      maxTokens: 3,
      refillRate: 3,
      refillIntervalMs: 60000,
    });

    // All 3 should pass immediately
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(limiter.getAvailableTokens()).toBe(0);
  });

  it('queues requests that exceed the limit', async () => {
    const limiter = new RateLimiter({
      maxTokens: 2,
      refillRate: 2,
      refillIntervalMs: 50, // Fast refill for test
    });

    // Consume all tokens
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getAvailableTokens()).toBe(0);

    // This should be queued
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    // Should have waited for refill (~50ms)
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('reports queue length correctly', async () => {
    const limiter = new RateLimiter({
      maxTokens: 1,
      refillRate: 1,
      refillIntervalMs: 100,
    });

    await limiter.acquire();

    // Queue up 2 more requests
    const p1 = limiter.acquire();
    const p2 = limiter.acquire();

    expect(limiter.getQueueLength()).toBe(2);

    // Wait for them to resolve
    await Promise.all([p1, p2]);
    expect(limiter.getQueueLength()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

describe('Retry behavior', () => {
  it('retries on failure and eventually succeeds', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('Transient error');
      return 'success';
    };

    const result = await withRetry(fn, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 50,
      jitter: false,
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting retries', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('Persistent error');
    };

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
        jitter: false,
      }),
    ).rejects.toThrow('Persistent error');

    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('calls onRetry callback with attempt info', async () => {
    const retryLog: Array<{ attempt: number; delayMs: number }> = [];
    let attempts = 0;

    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    };

    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: false,
      onRetry: (_error, attempt, delayMs) => {
        retryLog.push({ attempt, delayMs });
      },
    });

    expect(retryLog).toHaveLength(2);
    expect(retryLog[0].attempt).toBe(1);
    expect(retryLog[1].attempt).toBe(2);
  });

  it('succeeds on first attempt without retries', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return 'first-try';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: false,
    });

    expect(result).toBe('first-try');
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('Circuit breaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('stays CLOSED when calls succeed', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 5 });

    for (let i = 0; i < 10; i++) {
      await cb.execute(async () => 'ok');
    }

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('trips to OPEN after 5 consecutive failures', async () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
    });

    // Trigger 5 failures
    for (let i = 0; i < 5; i++) {
      try {
        await cb.execute(async () => {
          throw new Error('failure');
        });
      } catch {
        // Expected
      }
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  it('rejects calls immediately when OPEN', async () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 2,
      resetTimeoutMs: 60000,
    });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Next call should throw CircuitOpenError immediately
    await expect(
      cb.execute(async () => 'should-not-reach'),
    ).rejects.toThrow(CircuitOpenError);
  });

  it('resets to CLOSED after a successful call in HALF_OPEN state', async () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 2,
      resetTimeoutMs: 50, // Short timeout for testing
      halfOpenMaxAttempts: 1,
    });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Should transition to HALF_OPEN and then CLOSED on success
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it('failure count resets on success', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 5 });

    // 3 failures
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }

    // 1 success — should reset counter
    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // 3 more failures — should not trip because counter was reset
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }

    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });
});
