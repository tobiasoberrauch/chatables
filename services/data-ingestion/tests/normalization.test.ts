/**
 * Normalization Layer -- Unit Tests
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
  it('EUR + USD -> EUR/USD (not inverted)', () => {
    const result = normalizeFxPair('EUR', 'USD');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
    expect(result.pair).toBe('EUR/USD');
    expect(result.wasInverted).toBe(false);
  });

  it('USD + EUR -> EUR/USD (inverted)', () => {
    const result = normalizeFxPair('USD', 'EUR');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
    expect(result.pair).toBe('EUR/USD');
    expect(result.wasInverted).toBe(true);
  });

  it('GBP + USD -> GBP/USD (GBP has higher priority)', () => {
    const result = normalizeFxPair('GBP', 'USD');
    expect(result.base).toBe('GBP');
    expect(result.quote).toBe('USD');
    expect(result.wasInverted).toBe(false);
  });

  it('USD + JPY -> USD/JPY (not inverted)', () => {
    const result = normalizeFxPair('USD', 'JPY');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.pair).toBe('USD/JPY');
    expect(result.wasInverted).toBe(false);
  });

  it('JPY + USD -> USD/JPY (inverted)', () => {
    const result = normalizeFxPair('JPY', 'USD');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.pair).toBe('USD/JPY');
    expect(result.wasInverted).toBe(true);
  });

  it('EUR + GBP -> EUR/GBP (EUR has highest priority)', () => {
    const result = normalizeFxPair('EUR', 'GBP');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('GBP');
  });

  it('GBP + EUR -> EUR/GBP (inverted)', () => {
    const result = normalizeFxPair('GBP', 'EUR');
    expect(result.pair).toBe('EUR/GBP');
    expect(result.wasInverted).toBe(true);
  });

  it('AUD + NZD -> AUD/NZD', () => {
    const result = normalizeFxPair('AUD', 'NZD');
    expect(result.pair).toBe('AUD/NZD');
    expect(result.wasInverted).toBe(false);
  });

  it('handles lowercase input', () => {
    const result = normalizeFxPair('eur', 'usd');
    expect(result.base).toBe('EUR');
    expect(result.quote).toBe('USD');
  });

  it('handles exotic pairs with equal priority (alphabetical tiebreaker)', () => {
    // Both SGD and HKD have priority 0. When equal, alphabetical order is used.
    // HKD < SGD alphabetically, so HKD becomes the base.
    const result = normalizeFxPair('SGD', 'HKD');
    expect(result.base).toBe('HKD');
    expect(result.quote).toBe('SGD');
    expect(result.wasInverted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISIN format validation
// ---------------------------------------------------------------------------

describe('ISIN format validation', () => {
  it('validates a correct ISIN: US0378331005 (Apple)', () => {
    const result = validateISIN('US0378331005');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects ISIN with invalid length (11 chars)', () => {
    const result = validateISIN('US037833100');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('12 characters');
  });

  it('rejects ISIN with invalid length (13 chars)', () => {
    const result = validateISIN('US03783310050');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('12 characters');
  });

  it('rejects ISIN with wrong check digit', () => {
    const result = validateISIN('US0378331009');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('check digit');
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

  it('validates ISIN: US5949181045 (Microsoft)', () => {
    const result = validateISIN('US5949181045');
    expect(result.valid).toBe(true);
  });

  it('validates a German ISIN: DE0007236101 (Siemens)', () => {
    const result = validateISIN('DE0007236101');
    expect(result.valid).toBe(true);
  });

  it('validates a UK ISIN: GB0005405286 (HSBC)', () => {
    const result = validateISIN('GB0005405286');
    expect(result.valid).toBe(true);
  });

  it('validates GB0002634946 (BAE Systems)', () => {
    const result = validateISIN('GB0002634946');
    expect(result.valid).toBe(true);
  });

  it('validates DE0007100000 (Daimler)', () => {
    const result = validateISIN('DE0007100000');
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adjusted vs unadjusted price calculation
// ---------------------------------------------------------------------------

describe('Adjusted vs unadjusted price calculation', () => {
  it('4:1 forward split: $400 -> $100', () => {
    expect(adjustPriceForSplit(400, 4)).toBe(100);
  });

  it('2:1 forward split: $200 -> $100', () => {
    expect(adjustPriceForSplit(200, 2)).toBe(100);
  });

  it('20:1 split: $2000 -> $100', () => {
    expect(adjustPriceForSplit(2000, 20)).toBe(100);
  });

  it('1:4 reverse split: $25 -> $100', () => {
    expect(adjustPriceForSplit(25, 4, true)).toBe(100);
  });

  it('throws on zero or negative split ratio', () => {
    expect(() => adjustPriceForSplit(100, 0)).toThrow();
    expect(() => adjustPriceForSplit(100, -2)).toThrow();
  });
});

describe('adjustBarsForSplit', () => {
  it('adjusts pre-split bars for a 4:1 split', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', open: 400, high: 420, low: 390, close: 410, volume: 1000, vwap: 405 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', open: 408, high: 415, low: 395, close: 405, volume: 1200, vwap: 406 }),
      // Split ex-date
      makeBar({ timestamp: '2024-06-12T00:00:00.000Z', open: 102, high: 106, low: 98, close: 104, volume: 5000, vwap: 103 }),
      makeBar({ timestamp: '2024-06-13T00:00:00.000Z', open: 104, high: 108, low: 100, close: 106, volume: 4800, vwap: 104 }),
    ];

    const adjusted = adjustBarsForSplit(bars, '2024-06-12', 4);

    // Pre-split bars: prices divided by 4, volume multiplied by 4
    expect(adjusted[0].open).toBe(100);
    expect(adjusted[0].high).toBe(105);
    expect(adjusted[0].low).toBe(97.5);
    expect(adjusted[0].close).toBe(102.5);
    expect(adjusted[0].vwap).toBe(101.25);
    expect(adjusted[0].volume).toBe(4000);

    expect(adjusted[1].open).toBe(102);
    expect(adjusted[1].close).toBe(101.25);
    expect(adjusted[1].volume).toBe(4800);

    // Post-split bars unchanged
    expect(adjusted[2].open).toBe(102);
    expect(adjusted[2].high).toBe(106);
    expect(adjusted[2].close).toBe(104);
    expect(adjusted[2].volume).toBe(5000);

    // All marked as adjusted
    expect(adjusted.every((b) => b.isAdjusted)).toBe(true);
  });

  it('handles null VWAP in pre-split bars', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', vwap: null }),
    ];
    const adjusted = adjustBarsForSplit(bars, '2024-06-15', 4);
    expect(adjusted[0].vwap).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timestamp normalization to UTC
// ---------------------------------------------------------------------------

describe('Timestamp normalization to UTC', () => {
  it('converts XNYS (NYSE, UTC-5) local time to UTC', () => {
    const localTs = '2024-06-15T09:30:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XNYS');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T14:30:00.000Z');
  });

  it('converts XTKS (Tokyo, UTC+9) local time to UTC', () => {
    const localTs = '2024-06-15T09:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XTKS');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('XLON (London, UTC+0) - no offset', () => {
    const localTs = '2024-06-15T08:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XLON');
    expect(utc).toBe('2024-06-15T08:00:00.000Z');
  });

  it('converts XFRA (Frankfurt, UTC+1) to UTC', () => {
    const localTs = '2024-06-15T10:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XFRA');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T09:00:00.000Z');
  });

  it('converts XHKG (Hong Kong, UTC+8) to UTC', () => {
    const localTs = '2024-06-15T17:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XHKG');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T09:00:00.000Z');
  });

  it('converts XBOM (Bombay, UTC+5:30) to UTC', () => {
    const localTs = '2024-06-15T15:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'XBOM');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T09:30:00.000Z');
  });

  it('handles epoch milliseconds as input', () => {
    const epochMs = new Date('2024-06-15T09:30:00.000Z').getTime();
    const utc = normalizeTimestampToUTC(epochMs, 'XNYS');
    expect(new Date(utc).toISOString()).toBe('2024-06-15T14:30:00.000Z');
  });

  it('unknown exchange assumes UTC', () => {
    const localTs = '2024-06-15T12:00:00.000Z';
    const utc = normalizeTimestampToUTC(localTs, 'UNKNOWN_EXCHANGE');
    expect(utc).toBe('2024-06-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// sanitizeBar: missing/null field handling
// ---------------------------------------------------------------------------

describe('sanitizeBar', () => {
  it('passes through a complete valid bar', () => {
    const bar = makeBar();
    const result = sanitizeBar(bar);
    expect(result).not.toBeNull();
    expect(result!.close).toBe(102);
    expect(result!.vwap).toBe(100.5);
  });

  it('computes VWAP from (H+L+C)/3 when VWAP is null', () => {
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

  it('computes VWAP from (H+L+C)/3 when VWAP is undefined', () => {
    const bar = sanitizeBar({
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1000,
    });
    expect(bar).not.toBeNull();
    expect(bar!.vwap).toBeCloseTo((110 + 90 + 100) / 3);
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

  it('sets volume to 0 when volume is NaN', () => {
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

  it('returns null when all prices are zero', () => {
    const bar = sanitizeBar({ open: 0, high: 0, low: 0, close: 0, volume: 0 });
    expect(bar).toBeNull();
  });

  it('returns null when open is null', () => {
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
    expect(bar!.instrumentId).toBe('');
  });
});
