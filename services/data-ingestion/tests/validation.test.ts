/**
 * Validation Pipeline -- Unit Tests
 *
 * Tests the data validation layer that ensures market data integrity
 * before it enters the storage pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  validateOHLCVBar,
  validateBarSeries,
  validateInstrument,
  detectDuplicateBars,
  deduplicateBars,
  ValidationSeverity,
} from '../src/validation/validator';
import {
  BarSize,
  InstrumentType,
  AssetClass,
  type OHLCVBar,
  type Instrument,
} from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeBar(overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    instrumentId: 'inst-001',
    timestamp: '2024-06-15T14:30:00.000Z',
    open: 150,
    high: 155,
    low: 148,
    close: 152,
    volume: 50000,
    vwap: 151.5,
    trades: 1200,
    barSize: BarSize.DAY_1,
    isAdjusted: false,
    source: 'polygon',
    ...overrides,
  };
}

function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: 'test-uuid',
    isin: null,
    figi: null,
    type: InstrumentType.EQUITY,
    assetClass: AssetClass.EQUITY,
    name: 'Test Corp',
    primaryTicker: 'TEST',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [],
    country: 'US',
    sector: 'Technology',
    industry: null,
    isActive: true,
    delistedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Single OHLCV bar validation
// ---------------------------------------------------------------------------

describe('OHLCV bar validation', () => {
  it('passes for a valid bar', () => {
    const result = validateOHLCVBar(makeBar());
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === ValidationSeverity.ERROR)).toHaveLength(0);
  });

  it('fails when high < low', () => {
    const bar = makeBar({ high: 100, low: 110 });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.code === 'HIGH_LESS_THAN_LOW');
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(ValidationSeverity.ERROR);
  });

  it('fails when volume is negative', () => {
    const bar = makeBar({ volume: -100 });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.code === 'NEGATIVE_VOLUME');
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(ValidationSeverity.ERROR);
  });

  it('fails when any OHLC price is zero', () => {
    const bar = makeBar({ close: 0 });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.code === 'NON_POSITIVE_PRICE');
    expect(errors).toHaveLength(1);
  });

  it('fails when all prices are zero', () => {
    const bar = makeBar({ open: 0, high: 0, low: 0, close: 0 });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const zeroErrors = result.issues.filter((i) => i.code === 'NON_POSITIVE_PRICE');
    expect(zeroErrors).toHaveLength(1);
  });

  it('fails when a price is NaN', () => {
    const bar = makeBar({ open: NaN });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.code === 'NON_FINITE_NUMBER');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('fails when a price is Infinity', () => {
    const bar = makeBar({ high: Infinity });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
  });

  it('fails on invalid timestamp', () => {
    const bar = makeBar({ timestamp: 'not-a-date' });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.code === 'INVALID_TIMESTAMP');
    expect(errors).toHaveLength(1);
  });

  it('warns when open is outside high-low range', () => {
    const bar = makeBar({ open: 160, high: 155, low: 148, close: 152 });
    const result = validateOHLCVBar(bar);
    const warnings = result.issues.filter(
      (i) => i.code === 'OPEN_ABOVE_HIGH' && i.severity === ValidationSeverity.WARNING,
    );
    expect(warnings).toHaveLength(1);
  });

  it('warns when close is outside high-low range', () => {
    const bar = makeBar({ close: 145, high: 155, low: 148 });
    const result = validateOHLCVBar(bar);
    const warnings = result.issues.filter(
      (i) => i.code === 'CLOSE_BELOW_LOW' && i.severity === ValidationSeverity.WARNING,
    );
    expect(warnings).toHaveLength(1);
  });

  it('can have multiple errors simultaneously', () => {
    const bar = makeBar({ high: 100, low: 110, volume: -50, close: 0 });
    const result = validateOHLCVBar(bar);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.severity === ValidationSeverity.ERROR);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Price jump detection
// ---------------------------------------------------------------------------

describe('Price jump detection', () => {
  it('flags a > 50% price jump between consecutive bars', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 100 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', close: 160 }), // 60% jump
    ];
    const result = validateBarSeries(bars, { maxPriceJumpPercent: 50 });
    const jumps = result.issues.filter((i) => i.code === 'PRICE_JUMP');
    expect(jumps).toHaveLength(1);
    expect(jumps[0].severity).toBe(ValidationSeverity.WARNING);
  });

  it('does not flag a small price change', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 100 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', close: 102 }),
    ];
    const result = validateBarSeries(bars, { maxPriceJumpPercent: 50 });
    const jumps = result.issues.filter((i) => i.code === 'PRICE_JUMP');
    expect(jumps).toHaveLength(0);
  });

  it('detects a large drop as a price jump', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 200 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', close: 80 }), // 60% drop
    ];
    const result = validateBarSeries(bars, { maxPriceJumpPercent: 50 });
    const jumps = result.issues.filter((i) => i.code === 'PRICE_JUMP');
    expect(jumps).toHaveLength(1);
  });

  it('respects custom threshold', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 100 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', close: 115 }), // 15% jump
    ];
    const result10 = validateBarSeries(bars, { maxPriceJumpPercent: 10 });
    const result20 = validateBarSeries(bars, { maxPriceJumpPercent: 20 });

    expect(result10.issues.filter((i) => i.code === 'PRICE_JUMP')).toHaveLength(1);
    expect(result20.issues.filter((i) => i.code === 'PRICE_JUMP')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timestamp ordering validation
// ---------------------------------------------------------------------------

describe('Timestamp ordering validation', () => {
  it('passes for chronologically ordered bars', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-12T00:00:00.000Z' }),
    ];
    const result = validateBarSeries(bars);
    const orderErrors = result.issues.filter((i) => i.code === 'TIMESTAMP_ORDER');
    expect(orderErrors).toHaveLength(0);
  });

  it('fails when bars are out of order', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-12T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-13T00:00:00.000Z' }),
    ];
    const result = validateBarSeries(bars);
    const orderErrors = result.issues.filter((i) => i.code === 'TIMESTAMP_ORDER');
    expect(orderErrors).toHaveLength(1);
    expect(orderErrors[0].index).toBe(1);
  });

  it('detects duplicate timestamps', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
    ];
    const result = validateBarSeries(bars);
    const dupes = result.issues.filter((i) => i.code === 'DUPLICATE_TIMESTAMP');
    expect(dupes).toHaveLength(1);
  });

  it('handles empty bar series', () => {
    const result = validateBarSeries([]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('handles single bar series', () => {
    const result = validateBarSeries([makeBar()]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Instrument field completeness checks
// ---------------------------------------------------------------------------

describe('Instrument field completeness', () => {
  it('passes for a fully populated instrument', () => {
    const instrument = makeInstrument();
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(true);
  });

  it('fails when id is missing', () => {
    const instrument = makeInstrument({ id: '' });
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.field === 'id');
    expect(errors).toHaveLength(1);
  });

  it('fails when primaryTicker is missing', () => {
    const instrument = makeInstrument({ primaryTicker: '' });
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(false);
  });

  it('fails when currency is missing', () => {
    const instrument = makeInstrument({ currency: '' });
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(false);
  });

  it('fails when name is missing', () => {
    const instrument = makeInstrument({ name: '' });
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(false);
  });

  it('reports error on invalid currency code format', () => {
    const instrument = makeInstrument({ currency: 'USDD' });
    const result = validateInstrument(instrument);
    const currencyErrors = result.issues.filter((i) => i.code === 'INVALID_CURRENCY');
    expect(currencyErrors).toHaveLength(1);
  });

  it('warns on invalid country code format', () => {
    const instrument = makeInstrument({ country: 'USA' });
    const result = validateInstrument(instrument);
    const countryWarnings = result.issues.filter((i) => i.code === 'INVALID_COUNTRY');
    expect(countryWarnings).toHaveLength(1);
  });

  it('allows null optional fields', () => {
    const instrument = makeInstrument({
      isin: null,
      figi: null,
      sector: null,
      industry: null,
    });
    const result = validateInstrument(instrument);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate bar detection and deduplication
// ---------------------------------------------------------------------------

describe('Duplicate bar detection', () => {
  it('detects duplicate bars with same timestamp', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
    ];
    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toEqual([2]);
  });

  it('returns empty array when no duplicates', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
    ];
    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toHaveLength(0);
  });

  it('deduplicates bars keeping first occurrence', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 100 }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z', close: 102 }),
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z', close: 101 }),
    ];
    const deduped = deduplicateBars(bars);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].close).toBe(100); // Keeps first occurrence
    expect(deduped[1].close).toBe(102);
  });

  it('detects multiple duplicate groups', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2024-06-11T00:00:00.000Z' }),
    ];
    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toEqual([2, 3]);
  });
});
