import { describe, it, expect } from 'vitest';
import {
  adjustBarsForSplit,
  normalizeFxPair,
  sanitizeBar,
} from '../src/normalization/normalizer';
import type { OHLCVBar, BarSize } from '../../../shared/src/types/instrument';

/** Helper to create a valid OHLCV bar */
function makeBar(overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    instrumentId: 'test-instrument-001',
    timestamp: '2025-01-15T14:30:00.000Z',
    open: 100,
    high: 105,
    low: 98,
    close: 103,
    volume: 50000,
    vwap: 102,
    trades: 1200,
    barSize: '1d' as BarSize,
    isAdjusted: false,
    source: 'test',
    ...overrides,
  };
}

describe('Synthetic Edge Cases: Stock Split Mid-Dataset', () => {
  it('adjusts pre-split bars for a 4:1 forward split', () => {
    const preSplit1 = makeBar({ timestamp: '2025-06-01T00:00:00Z', open: 400, high: 420, low: 390, close: 410, volume: 10000 });
    const preSplit2 = makeBar({ timestamp: '2025-06-02T00:00:00Z', open: 410, high: 430, low: 400, close: 420, volume: 12000 });
    const splitDay = makeBar({ timestamp: '2025-06-03T00:00:00Z', open: 105, high: 110, low: 100, close: 108, volume: 48000 });
    const postSplit = makeBar({ timestamp: '2025-06-04T00:00:00Z', open: 108, high: 112, low: 105, close: 110, volume: 50000 });

    const bars = [preSplit1, preSplit2, splitDay, postSplit];
    const adjusted = adjustBarsForSplit(bars, '2025-06-03', 4);

    // Pre-split bars: prices divided by 4, volume multiplied by 4
    expect(adjusted[0].close).toBeCloseTo(410 / 4, 8);
    expect(adjusted[0].open).toBeCloseTo(400 / 4, 8);
    expect(adjusted[0].volume).toBe(10000 * 4);
    expect(adjusted[1].close).toBeCloseTo(420 / 4, 8);
    expect(adjusted[1].volume).toBe(12000 * 4);

    // Post-split bars: unchanged prices
    expect(adjusted[2].close).toBe(108);
    expect(adjusted[2].volume).toBe(48000);
    expect(adjusted[3].close).toBe(110);

    // All bars marked as adjusted
    expect(adjusted.every((b) => b.isAdjusted)).toBe(true);

    // Price continuity: adjusted pre-split close should be near post-split open
    const adjustedPreSplitClose = adjusted[1].close; // ~105
    const postSplitOpen = adjusted[2].open;           // 105
    expect(Math.abs(adjustedPreSplitClose - postSplitOpen)).toBeLessThan(1);
  });

  it('handles reverse split (1:10)', () => {
    const preSplit = makeBar({ timestamp: '2025-03-01T00:00:00Z', open: 0.5, high: 0.6, low: 0.4, close: 0.55, volume: 1000000 });
    const postSplit = makeBar({ timestamp: '2025-03-02T00:00:00Z', open: 5.5, high: 6.0, low: 5.0, close: 5.8, volume: 100000 });

    const adjusted = adjustBarsForSplit([preSplit, postSplit], '2025-03-02', 10, true);

    // Pre-split: prices multiplied by 10, volume divided by 10
    expect(adjusted[0].close).toBeCloseTo(5.5, 4);
    expect(adjusted[0].volume).toBe(100000);

    // Post-split: unchanged
    expect(adjusted[1].close).toBe(5.8);
  });
});

describe('Synthetic Edge Cases: FX Pairs with JPY', () => {
  it('normalizes USD/JPY correctly (large quote values)', () => {
    const result = normalizeFxPair('USD', 'JPY');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.pair).toBe('USD/JPY');
    expect(result.wasInverted).toBe(false);
  });

  it('normalizes JPY/USD to USD/JPY (inverts)', () => {
    const result = normalizeFxPair('JPY', 'USD');
    expect(result.base).toBe('USD');
    expect(result.quote).toBe('JPY');
    expect(result.wasInverted).toBe(true);
  });

  it('sanitizes bars with very large price values (JPY pairs)', () => {
    const bar = sanitizeBar({
      instrumentId: 'fx-usdjpy',
      timestamp: '2025-01-15T00:00:00Z',
      open: 149.85,
      high: 150.23,
      low: 149.50,
      close: 150.10,
      volume: 0,  // FX volume can be 0
      barSize: '1d' as BarSize,
      isAdjusted: false,
      source: 'alphaVantage',
    });

    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(150.10);
    expect(bar!.volume).toBe(0); // Zero volume is valid for FX
  });

  it('normalizes exotic FX pair with unknown currency', () => {
    const result = normalizeFxPair('ZAR', 'JPY');
    // Neither has high priority, but JPY(1) > ZAR(0)
    expect(result.base).toBe('JPY');
    expect(result.quote).toBe('ZAR');
  });
});

describe('Synthetic Edge Cases: Delisted Instrument', () => {
  it('bars for delisted instrument should still validate', () => {
    const bar = sanitizeBar({
      instrumentId: 'delisted-stock-001',
      timestamp: '2020-03-15T00:00:00Z',
      open: 2.50,
      high: 2.55,
      low: 2.30,
      close: 2.35,
      volume: 500,
      barSize: '1d' as BarSize,
      isAdjusted: false,
      source: 'polygon',
    });

    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(2.35);
  });

  it('all-zero bar (post-delisting placeholder) should be rejected', () => {
    const bar = sanitizeBar({
      instrumentId: 'delisted-stock-001',
      timestamp: '2020-03-16T00:00:00Z',
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    });

    expect(bar).toBeNull();
  });
});

describe('Synthetic Edge Cases: Duplicate Bars', () => {
  it('two bars with identical timestamps can both be normalized', () => {
    const bar1 = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: 100, high: 105, low: 98, close: 103,
      volume: 50000,
      barSize: '1m' as BarSize,
      source: 'polygon',
    });

    const bar2 = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: 100, high: 105, low: 98, close: 103,
      volume: 50000,
      barSize: '1m' as BarSize,
      source: 'iex', // Different source
    });

    expect(bar1).not.toBeNull();
    expect(bar2).not.toBeNull();
    // DB unique constraint (instrument_id, timestamp, bar_size, is_adjusted) handles dedup
  });
});

describe('Synthetic Edge Cases: Extreme Volume Spikes', () => {
  it('extremely high volume bar should still normalize', () => {
    const bar = sanitizeBar({
      instrumentId: 'meme-stock',
      timestamp: '2025-01-15T14:30:00Z',
      open: 50, high: 80, low: 45, close: 75,
      volume: 500_000_000, // 500M shares
      barSize: '1d' as BarSize,
      source: 'polygon',
    });

    expect(bar).not.toBeNull();
    expect(bar!.volume).toBe(500_000_000);
  });
});

describe('Synthetic Edge Cases: Missing VWAP', () => {
  it('computes VWAP from (H+L+C)/3 when VWAP is null', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: 100, high: 110, low: 90, close: 105,
      volume: 50000,
      vwap: null,
      barSize: '1d' as BarSize,
      source: 'test',
    });

    expect(bar).not.toBeNull();
    // (110 + 90 + 105) / 3 = 101.666...
    expect(bar!.vwap).toBeCloseTo((110 + 90 + 105) / 3, 4);
  });

  it('preserves VWAP when provided', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: 100, high: 110, low: 90, close: 105,
      volume: 50000,
      vwap: 102.5,
      barSize: '1d' as BarSize,
      source: 'test',
    });

    expect(bar).not.toBeNull();
    expect(bar!.vwap).toBe(102.5);
  });
});

describe('Synthetic Edge Cases: Non-Finite Prices', () => {
  it('rejects bar with NaN price', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: NaN, high: 110, low: 90, close: 105,
      volume: 50000,
    });

    expect(bar).toBeNull();
  });

  it('rejects bar with Infinity price', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00Z',
      open: 100, high: Infinity, low: 90, close: 105,
      volume: 50000,
    });

    expect(bar).toBeNull();
  });
});
