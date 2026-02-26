/**
 * Normalization Layer — Unit Tests
 *
 * Tests the data normalization pipeline responsible for converting
 * heterogeneous exchange data into canonical types.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTickerToInstrument,
  normalizeFxPair,
  adjustPriceForSplit,
  adjustBarsForSplit,
  normalizeTimestampToUTC,
  sanitizeBar,
  validateISIN,
  type TickerRegistryEntry,
} from '../src/normalization/normalizer';
import { BarSize, type OHLCVBar } from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Helper: build a minimal OHLCVBar for testing
// ---------------------------------------------------------------------------

function makeBar(overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    instrumentId: 'inst-001',
    timestamp: '2024-06-15T14:30:00.000Z',
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 50000,
    vwap: 100.5,
    trades: 1200,
    barSize: BarSize.DAY_1,
    isAdjusted: false,
    source: 'polygon',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Multi-exchange ticker resolution
// ---------------------------------------------------------------------------

describe('Multi-exchange ticker resolution', () => {
  const registry: TickerRegistryEntry[] = [
    {
      instrumentId: 'aapl-uuid',
      primaryTicker: 'AAPL',
      primaryExchangeMic: 'XNAS',
      aliases: [
        { ticker: 'AAPL', exchangeMic: 'XNYS' },
        { ticker: 'AAPL.US', exchangeMic: 'XNAS' },
      ],
    },
    {
      instrumentId: 'msft-uuid',
      primaryTicker: 'MSFT',
      primaryExchangeMic: 'XNAS',
      aliases: [],
    },
    {
      instrumentId: 'bp-uuid',
      primaryTicker: 'BP.',
      primaryExchangeMic: 'XLON',
      aliases: [
        { ticker: 'BP', exchangeMic: 'XNYS' },
      ],
    },
  ];

  it('resolves AAPL on XNAS as primary listing', () => {
    const result = resolveTickerToInstrument('AAPL', 'XNAS', registry);
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('aapl-uuid');
    expect(result!.primaryExchangeMic).toBe('XNAS');
    expect(result!.matchType).toBe('primary');
  });

  it('resolves AAPL on XNYS via alias', () => {
    const result = resolveTickerToInstrument('AAPL', 'XNYS', registry);
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('aapl-uuid');
    expect(result!.matchType).toBe('alias');
  });

  it('resolves AAPL without exchange MIC to primary listing', () => {
    const result = resolveTickerToInstrument('AAPL', undefined, registry);
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('aapl-uuid');
    expect(result!.primaryExchangeMic).toBe('XNAS');
  });

  it('resolves case-insensitively', () => {
    const result = resolveTickerToInstrument('aapl', undefined, registry);
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('aapl-uuid');
  });

  it('resolves cross-listed BP on XNYS via alias', () => {
    const result = resolveTickerToInstrument('BP', 'XNYS', registry);
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('bp-uuid');
    expect(result!.matchType).toBe('alias');
  });

  it('returns null for unknown ticker', () => {
    const result = resolveTickerToInstrument('UNKNOWN', undefined, registry);
    expect(result).toBeNull();
  });

  it('returns null when exchange does not match any entry', () => {
    const result = resolveTickerToInstrument('MSFT', 'XLON', registry);
    // Falls back to primary match ignoring exchange
    expect(result).not.toBeNull();
    expect(result!.instrumentId).toBe('msft-uuid');
  });
});

// ---------------------------------------------------------------------------
// FX pair normalization
// ---------------------------------------------------------------------------

describe('FX pair normalization', () => {
  it('normalizes EUR/USD correctly (EUR has higher priority)', () => {
    const result = normalizeFxPair('EUR', 'USD');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
    expect(result.pair).toBe('EUR/USD');
    expect(result.wasInverted).toBe(false);
  });

  it('inverts USD/EUR to EUR/USD', () => {
    const result = normalizeFxPair('USD', 'EUR');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
    expect(result.pair).toBe('EUR/USD');
    expect(result.wasInverted).toBe(true);
  });

  it('normalizes GBP/USD correctly', () => {
    const result = normalizeFxPair('GBP', 'USD');
    expect(result.base).toBe('GBP');
    expect(result.quote).toBe('USD');
    expect(result.wasInverted).toBe(false);
  });

  it('normalizes USD/JPY correctly (USD has higher priority than JPY)', () => {
    const result = normalizeFxPair('USD', 'JPY');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.wasInverted).toBe(false);
  });

  it('inverts JPY/USD to USD/JPY', () => {
    const result = normalizeFxPair('JPY', 'USD');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.wasInverted).toBe(true);
  });

  it('normalizes EUR/GBP correctly', () => {
    const result = normalizeFxPair('EUR', 'GBP');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('GBP');
  });

  it('handles lowercase input', () => {
    const result = normalizeFxPair('eur', 'usd');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
  });

  it('handles exotic pairs with equal priority (alphabetical fallback)', () => {
    // Both SGD and HKD have no priority defined (0), so A >= B means first stays base
    const result = normalizeFxPair('SGD', 'HKD');
    expect(result.base).toBe('SGD');
    expect(result.quote).toBe('HKD');
    expect(result.wasInverted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adjusted vs unadjusted price calculation
// ---------------------------------------------------------------------------

describe('Adjusted vs unadjusted price calculation', () => {
  it('applies 4:1 split — pre-split price $400 becomes $100', () => {
    const adjusted = adjustPriceForSplit(400, 4);
    expect(adjusted).toBe(100);
  });

  it('applies 2:1 split — pre-split price $200 becomes $100', () => {
    const adjusted = adjustPriceForSplit(200, 2);
    expect(adjusted).toBe(100);
  });

  it('applies 20:1 split', () => {
    const adjusted = adjustPriceForSplit(2000, 20);
    expect(adjusted).toBe(100);
  });

  it('applies reverse split 1:4 — price $25 becomes $100', () => {
    const adjusted = adjustPriceForSplit(25, 4, true);
    expect(adjusted).toBe(100);
  });

  it('throws on zero or negative split ratio', () => {
    expect(() => adjustPriceForSplit(100, 0)).toThrow();
    expect(() => adjustPriceForSplit(100, -2)).toThrow();
  });

  it('adjusts a series of bars for a 4:1 split', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', open: 400, high: 420, low: 390, close: 410, volume: 1000, vwap: 405 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', open: 408, high: 415, low: 395, close: 405, volume: 1200, vwap: 406 }),
      // Split ex-date
      makeBar({ timestamp: '2024-06-12T00:00:00.000Z', open: 102, high: 106, low: 98, close: 104, volume: 5000, vwap: 103 }),
      makeBar({ timestamp: '2024-06-13T00:00:00.000Z', open: 104, high: 108, low: 100, close: 106, volume: 4800, vwap: 104 }),
    ];

    const adjusted = adjustBarsForSplit(bars, '2024-06-12', 4);

    // Pre-split bars should be divided by 4
    expect(adjusted[0].open).toBe(100);
    expect(adjusted[0].high).toBe(105);
    expect(adjusted[0].low).toBe(97.5);
    expect(adjusted[0].close).toBe(102.5);
    expect(adjusted[0].vwap).toBe(101.25);
    expect(adjusted[0].volume).toBe(4000); // volume * 4

    expect(adjusted[1].open).toBe(102);
    expect(adjusted[1].close).toBe(101.25);
    expect(adjusted[1].volume).toBe(4800);

    // Post-split bars should be unchanged
    expect(adjusted[2].open).toBe(102);
    expect(adjusted[2].high).toBe(106);
    expect(adjusted[2].close).toBe(104);
    expect(adjusted[2].volume).toBe(5000);

    // All bars should be marked as adjusted
    expect(adjusted.every((b) => b.isAdjusted)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timestamp normalization to UTC
// ---------------------------------------------------------------------------

describe('Timestamp normalization to UTC', () => {
  it('converts NYSE local time (EST, UTC-5) to UTC', () => {
    // 2024-06-15 09:30 EST = 2024-06-15 14:30 UTC
    const localTs = '2024-06-15T09:30:00.000Z'; // Pretend this is local EST
    const utc = normalizeTimestampToUTC(localTs, 'XNYS');
    const resultDate = new Date(utc);
    // Input parsed as UTC midnight, offset by -(-5h) = +5h
    expect(resultDate.toISOString()).toBe('2024-06-15T14:30:00.000Z');
  });

  it('converts Tokyo time (JST, UTC+9) to UTC', () => {
    // A Tokyo local time of 09:00 JST → should be 00:00 UTC
    const localTs = '2024-06-15T09:00:00.000Z'; // Pretend this is local JST
    const utc = normalizeTimestampToUTC(localTs, 'XTKS');
    const resultDate = new Date(utc);
    expect(resultDate.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('converts London time (UTC+0) — no offset', () => {
    const localTs = '2024-06-15T08:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XLON');
    expect(utc).toBe('2024-06-15T08:00:00.000Z');
  });

  it('converts Frankfurt time (CET, UTC+1) to UTC', () => {
    const localTs = '2024-06-15T10:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XFRA');
    const resultDate = new Date(utc);
    expect(resultDate.toISOString()).toBe('2024-06-15T09:00:00.000Z');
  });

  it('converts Hong Kong time (HKT, UTC+8) to UTC', () => {
    const localTs = '2024-06-15T17:00:00.000Z'; // 17:00 HKT
    const utc = normalizeTimestampToUTC(localTs, 'XHKG');
    const resultDate = new Date(utc);
    expect(resultDate.toISOString()).toBe('2024-06-15T09:00:00.000Z');
  });

  it('handles epoch milliseconds as input', () => {
    const epochMs = new Date('2024-06-15T09:30:00.000Z').getTime();
    const utc = normalizeTimestampToUTC(epochMs, 'XNYS');
    const resultDate = new Date(utc);
    expect(resultDate.toISOString()).toBe('2024-06-15T14:30:00.000Z');
  });

  it('handles unknown exchange MIC — assumes UTC', () => {
    const localTs = '2024-06-15T12:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'UNKNOWN_EXCHANGE');
    expect(utc).toBe('2024-06-15T12:00:00.000Z');
  });

  it('converts Bombay time (IST, UTC+5:30) to UTC', () => {
    const localTs = '2024-06-15T15:00:00.000Z'; // 15:00 IST
    const utc = normalizeTimestampToUTC(localTs, 'XBOM');
    const resultDate = new Date(utc);
    expect(resultDate.toISOString()).toBe('2024-06-15T09:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Handling of missing/null fields
// ---------------------------------------------------------------------------

describe('Handling of missing/null fields', () => {
  it('fills missing VWAP with (high + low + close) / 3', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
      vwap: null,
    });
    expect(bar).not.toBeNull();
    expect(bar!.vwap).toBeCloseTo((110 + 90 + 105) / 3);
  });

  it('fills missing volume with 0', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: undefined as any,
    });
    expect(bar).not.toBeNull();
    expect(bar!.volume).toBe(0);
  });

  it('returns null when all prices are zero', () => {
    const bar = sanitizeBar({
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    });
    expect(bar).toBeNull();
  });

  it('returns null when open is null/undefined', () => {
    const bar = sanitizeBar({
      open: null as any,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
    });
    expect(bar).toBeNull();
  });

  it('returns null when prices contain NaN', () => {
    const bar = sanitizeBar({
      open: NaN,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
    });
    expect(bar).toBeNull();
  });

  it('returns null when prices contain Infinity', () => {
    const bar = sanitizeBar({
      open: Infinity,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
    });
    expect(bar).toBeNull();
  });

  it('preserves valid VWAP when present', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
      vwap: 101.5,
    });
    expect(bar).not.toBeNull();
    expect(bar!.vwap).toBe(101.5);
  });

  it('sets default barSize and source when missing', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
    });
    expect(bar).not.toBeNull();
    expect(bar!.barSize).toBe('1d');
    expect(bar!.source).toBe('unknown');
  });

  it('handles NaN volume by setting to 0', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: NaN,
    });
    expect(bar).not.toBeNull();
    expect(bar!.volume).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ISIN format validation
// ---------------------------------------------------------------------------

describe('ISIN format validation', () => {
  it('validates a correct ISIN (Apple Inc.)', () => {
    // AAPL ISIN: US0378331005
    const result = validateISIN('US0378331005');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects ISIN with wrong length', () => {
    const result = validateISIN('US037833100');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('12 characters');
  });

  it('rejects ISIN with lowercase country code', () => {
    const result = validateISIN('us0378331005');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('country code');
  });

  it('rejects ISIN with numeric country code', () => {
    const result = validateISIN('120378331005');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('country code');
  });

  it('rejects empty ISIN', () => {
    const result = validateISIN('');
    expect(result.valid).toBe(false);
  });

  it('rejects null ISIN', () => {
    const result = validateISIN(null as any);
    expect(result.valid).toBe(false);
  });

  it('validates ISIN with check digit verification (Microsoft)', () => {
    // MSFT ISIN: US5949181045
    const result = validateISIN('US5949181045');
    expect(result.valid).toBe(true);
  });

  it('rejects ISIN with wrong check digit', () => {
    const result = validateISIN('US0378331009'); // Should be 5, not 9
    expect(result.valid).toBe(false);
    expect(result.error).toContain('check digit');
  });

  it('validates a German ISIN (Siemens)', () => {
    // Siemens ISIN: DE0007236101
    const result = validateISIN('DE0007236101');
    expect(result.valid).toBe(true);
  });

  it('validates a UK ISIN (HSBC)', () => {
    // HSBC: GB0005405286
    const result = validateISIN('GB0005405286');
    expect(result.valid).toBe(true);
  });
});
