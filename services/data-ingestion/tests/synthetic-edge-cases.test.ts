/**
 * Synthetic Edge Cases -- Unit Tests
 *
 * Tests unusual but realistic market data scenarios:
 *   - Stock splits mid-dataset with price continuity verification
 *   - FX pairs with JPY (large numbers like 150.XX)
 *   - Delisted instrument handling
 *   - Duplicate bar detection
 */

import { describe, it, expect } from 'vitest';
import {
  adjustBarsForSplit,
  normalizeFxPair,
  sanitizeBar,
} from '../src/normalization/normalizer';
import {
  validateBarSeries,
  detectDuplicateBars,
  deduplicateBars,
  ValidationSeverity,
} from '../src/validation/validator';
import type { OHLCVBar } from '../../../shared/src/types/instrument';
import { BarSize } from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Helper: create a valid OHLCV bar
// ---------------------------------------------------------------------------

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
    barSize: BarSize.DAY_1,
    isAdjusted: false,
    source: 'test',
    ...overrides,
  };
}

// ============================================================================
// Stock Split Mid-Dataset
// ============================================================================

describe('Stock split mid-dataset', () => {
  it('4:1 forward split: pre-split prices divided, post-split unchanged', () => {
    const preSplit1 = makeBar({
      timestamp: '2025-06-01T00:00:00.000Z',
      open: 400, high: 420, low: 390, close: 410, volume: 10000,
    });
    const preSplit2 = makeBar({
      timestamp: '2025-06-02T00:00:00.000Z',
      open: 410, high: 430, low: 400, close: 420, volume: 12000,
    });
    const splitDay = makeBar({
      timestamp: '2025-06-03T00:00:00.000Z',
      open: 105, high: 110, low: 100, close: 108, volume: 48000,
    });
    const postSplit = makeBar({
      timestamp: '2025-06-04T00:00:00.000Z',
      open: 108, high: 112, low: 105, close: 110, volume: 50000,
    });

    const bars = [preSplit1, preSplit2, splitDay, postSplit];
    const adjusted = adjustBarsForSplit(bars, '2025-06-03', 4);

    // Pre-split bars: prices divided by 4, volume multiplied by 4
    expect(adjusted[0].close).toBeCloseTo(410 / 4, 8);
    expect(adjusted[0].open).toBeCloseTo(400 / 4, 8);
    expect(adjusted[0].high).toBeCloseTo(420 / 4, 8);
    expect(adjusted[0].low).toBeCloseTo(390 / 4, 8);
    expect(adjusted[0].volume).toBe(10000 * 4);

    expect(adjusted[1].close).toBeCloseTo(420 / 4, 8);
    expect(adjusted[1].volume).toBe(12000 * 4);

    // Post-split bars: unchanged
    expect(adjusted[2].close).toBe(108);
    expect(adjusted[2].volume).toBe(48000);
    expect(adjusted[3].close).toBe(110);

    // All bars marked as adjusted
    expect(adjusted.every((b) => b.isAdjusted)).toBe(true);
  });

  it('verifies pre/post split price continuity', () => {
    const preSplit = makeBar({
      timestamp: '2025-06-02T00:00:00.000Z',
      open: 410, high: 430, low: 400, close: 420, volume: 12000,
    });
    const postSplit = makeBar({
      timestamp: '2025-06-03T00:00:00.000Z',
      open: 105, high: 110, low: 100, close: 108, volume: 48000,
    });

    const adjusted = adjustBarsForSplit([preSplit, postSplit], '2025-06-03', 4);

    // Adjusted pre-split close (420/4 = 105) should be near post-split open (105)
    const adjustedPreSplitClose = adjusted[0].close; // 105
    const postSplitOpen = adjusted[1].open;           // 105
    expect(Math.abs(adjustedPreSplitClose - postSplitOpen)).toBeLessThan(1);
  });

  it('handles reverse split (1:10)', () => {
    const preSplit = makeBar({
      timestamp: '2025-03-01T00:00:00.000Z',
      open: 0.5, high: 0.6, low: 0.4, close: 0.55, volume: 1000000,
    });
    const postSplit = makeBar({
      timestamp: '2025-03-02T00:00:00.000Z',
      open: 5.5, high: 6.0, low: 5.0, close: 5.8, volume: 100000,
    });

    const adjusted = adjustBarsForSplit([preSplit, postSplit], '2025-03-02', 10, true);

    // Pre-split: prices multiplied by 10, volume divided by 10
    expect(adjusted[0].close).toBeCloseTo(5.5, 4);
    expect(adjusted[0].open).toBeCloseTo(5.0, 4);
    expect(adjusted[0].volume).toBe(100000); // 1000000 / 10

    // Post-split: unchanged
    expect(adjusted[1].close).toBe(5.8);
    expect(adjusted[1].volume).toBe(100000);
  });

  it('multi-split scenario: two splits in same dataset', () => {
    // First apply a 2:1 split, then a 3:1 split
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-01T00:00:00.000Z', open: 300, high: 310, low: 290, close: 300, volume: 1000 }),
      makeBar({ timestamp: '2025-03-01T00:00:00.000Z', open: 150, high: 160, low: 140, close: 155, volume: 2000 }),
      makeBar({ timestamp: '2025-06-01T00:00:00.000Z', open: 50, high: 55, low: 48, close: 52, volume: 6000 }),
    ];

    // Apply first split (2:1 at 2025-03-01)
    const afterFirst = adjustBarsForSplit(bars, '2025-03-01', 2);
    expect(afterFirst[0].close).toBeCloseTo(150, 8);
    expect(afterFirst[0].volume).toBe(2000);

    // Apply second split (3:1 at 2025-06-01) on the already-adjusted data
    const afterSecond = adjustBarsForSplit(afterFirst, '2025-06-01', 3);
    expect(afterSecond[0].close).toBeCloseTo(50, 8);
    expect(afterSecond[0].volume).toBe(6000);
    expect(afterSecond[1].close).toBeCloseTo(155 / 3, 4);
  });
});

// ============================================================================
// FX Pair with JPY (large numbers)
// ============================================================================

describe('FX pairs with JPY', () => {
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

  it('sanitizes bars with JPY-style large price values (150.XX)', () => {
    const bar = sanitizeBar({
      instrumentId: 'fx-usdjpy',
      timestamp: '2025-01-15T00:00:00.000Z',
      open: 149.85,
      high: 150.23,
      low: 149.50,
      close: 150.10,
      volume: 0, // FX volume can be 0
      barSize: BarSize.DAY_1,
      isAdjusted: false,
      source: 'alphaVantage',
    });

    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(150.10);
    expect(bar!.volume).toBe(0);
  });

  it('EUR/JPY normalization (EUR highest priority)', () => {
    const result = normalizeFxPair('JPY', 'EUR');
    expect(result.pair).toBe('EUR/JPY');
    expect(result.wasInverted).toBe(true);
  });

  it('normalizes exotic FX pair where JPY has higher priority than ZAR', () => {
    const result = normalizeFxPair('ZAR', 'JPY');
    // JPY priority=1, ZAR priority=0 => JPY is base
    expect(result.base).toBe('JPY');
    expect(result.quote).toBe('ZAR');
  });

  it('validates JPY bar series with typical 150.XX range', () => {
    const bars: OHLCVBar[] = [
      makeBar({
        instrumentId: 'fx-usdjpy',
        timestamp: '2025-01-10T00:00:00.000Z',
        open: 149.50, high: 150.20, low: 149.30, close: 150.00, volume: 0,
      }),
      makeBar({
        instrumentId: 'fx-usdjpy',
        timestamp: '2025-01-11T00:00:00.000Z',
        open: 150.00, high: 150.80, low: 149.80, close: 150.50, volume: 0,
      }),
      makeBar({
        instrumentId: 'fx-usdjpy',
        timestamp: '2025-01-12T00:00:00.000Z',
        open: 150.50, high: 151.00, low: 150.20, close: 150.75, volume: 0,
      }),
    ];

    const result = validateBarSeries(bars, { maxPriceJumpPercent: 50 });
    // No price jumps since changes are < 1%
    const jumps = result.issues.filter((i) => i.code === 'PRICE_JUMP');
    expect(jumps).toHaveLength(0);
  });
});

// ============================================================================
// Delisted Instrument Handling
// ============================================================================

describe('Delisted instrument handling', () => {
  it('bars for a delisted instrument should still normalize if prices are valid', () => {
    const bar = sanitizeBar({
      instrumentId: 'delisted-stock-001',
      timestamp: '2020-03-15T00:00:00.000Z',
      open: 2.50,
      high: 2.55,
      low: 2.30,
      close: 2.35,
      volume: 500,
      barSize: BarSize.DAY_1,
      isAdjusted: false,
      source: 'polygon',
    });

    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(2.35);
    expect(bar!.instrumentId).toBe('delisted-stock-001');
  });

  it('all-zero bar (post-delisting placeholder) is rejected', () => {
    const bar = sanitizeBar({
      instrumentId: 'delisted-stock-001',
      timestamp: '2020-03-16T00:00:00.000Z',
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    });

    expect(bar).toBeNull();
  });

  it('last trading day bar followed by delisting (price drop to penny)', () => {
    const bars: OHLCVBar[] = [
      makeBar({
        instrumentId: 'delisted-penny',
        timestamp: '2020-03-10T00:00:00.000Z',
        open: 5.00, high: 5.10, low: 4.80, close: 4.90, volume: 100000,
      }),
      makeBar({
        instrumentId: 'delisted-penny',
        timestamp: '2020-03-11T00:00:00.000Z',
        open: 4.90, high: 5.00, low: 0.50, close: 0.50, volume: 2000000,
      }),
    ];

    const result = validateBarSeries(bars, { maxPriceJumpPercent: 50 });
    // 89.8% drop should be flagged as a price jump
    const jumps = result.issues.filter((i) => i.code === 'PRICE_JUMP');
    expect(jumps).toHaveLength(1);
    expect(jumps[0].severity).toBe(ValidationSeverity.WARNING);
  });

  it('bar with very low but non-zero prices normalizes successfully', () => {
    const bar = sanitizeBar({
      instrumentId: 'penny-stock',
      timestamp: '2025-01-15T00:00:00.000Z',
      open: 0.001,
      high: 0.002,
      low: 0.001,
      close: 0.0015,
      volume: 10000000,
      barSize: BarSize.DAY_1,
      source: 'otc',
    });

    expect(bar).not.toBeNull();
    expect(bar!.close).toBe(0.0015);
    // VWAP computed as (H+L+C)/3
    expect(bar!.vwap).toBeCloseTo((0.002 + 0.001 + 0.0015) / 3, 10);
  });
});

// ============================================================================
// Duplicate Bar Detection
// ============================================================================

describe('Duplicate bar detection', () => {
  it('detects exact duplicate bars (same instrumentId, timestamp, barSize)', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', close: 100 }),
      makeBar({ timestamp: '2025-01-11T00:00:00.000Z', close: 102 }),
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', close: 101 }), // Duplicate timestamp
    ];

    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toEqual([2]);
  });

  it('does not flag bars with different timestamps as duplicates', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2025-01-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2025-01-12T00:00:00.000Z' }),
    ];

    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toHaveLength(0);
  });

  it('deduplicates keeping first occurrence', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', close: 100, source: 'polygon' }),
      makeBar({ timestamp: '2025-01-11T00:00:00.000Z', close: 102 }),
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', close: 101, source: 'iex' }),
    ];

    const deduped = deduplicateBars(bars);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].close).toBe(100); // First occurrence kept
    expect(deduped[0].source).toBe('polygon');
    expect(deduped[1].close).toBe(102);
  });

  it('bars with same timestamp but different instrumentId are not duplicates', () => {
    const bars: OHLCVBar[] = [
      makeBar({ instrumentId: 'AAPL', timestamp: '2025-01-10T00:00:00.000Z' }),
      makeBar({ instrumentId: 'GOOG', timestamp: '2025-01-10T00:00:00.000Z' }),
    ];

    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toHaveLength(0);
  });

  it('bars with same timestamp but different barSize are not duplicates', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', barSize: BarSize.DAY_1 }),
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z', barSize: BarSize.HOUR_1 }),
    ];

    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toHaveLength(0);
  });

  it('handles multiple duplicate groups', () => {
    const bars: OHLCVBar[] = [
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z' }),
      makeBar({ timestamp: '2025-01-11T00:00:00.000Z' }),
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z' }), // dup of 0
      makeBar({ timestamp: '2025-01-11T00:00:00.000Z' }), // dup of 1
      makeBar({ timestamp: '2025-01-10T00:00:00.000Z' }), // dup of 0 (triple)
    ];

    const duplicates = detectDuplicateBars(bars);
    expect(duplicates).toEqual([2, 3, 4]);

    const deduped = deduplicateBars(bars);
    expect(deduped).toHaveLength(2);
  });

  it('two bars from different sources with same timestamp are detected', () => {
    const bar1 = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: 100, high: 105, low: 98, close: 103,
      volume: 50000,
      barSize: BarSize.MINUTE_1,
      source: 'polygon',
    });

    const bar2 = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: 100, high: 105, low: 98, close: 103,
      volume: 50000,
      barSize: BarSize.MINUTE_1,
      source: 'iex',
    });

    expect(bar1).not.toBeNull();
    expect(bar2).not.toBeNull();

    // Both bars are valid individually but are duplicates by key
    const duplicates = detectDuplicateBars([bar1!, bar2!]);
    expect(duplicates).toEqual([1]);
  });
});

// ============================================================================
// Additional Synthetic Edge Cases
// ============================================================================

describe('Extreme volume spikes', () => {
  it('extremely high volume bar normalizes correctly', () => {
    const bar = sanitizeBar({
      instrumentId: 'meme-stock',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: 50, high: 80, low: 45, close: 75,
      volume: 500_000_000, // 500M shares
      barSize: BarSize.DAY_1,
      source: 'polygon',
    });

    expect(bar).not.toBeNull();
    expect(bar!.volume).toBe(500_000_000);
  });
});

describe('Non-finite prices', () => {
  it('rejects bar with NaN price', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: NaN, high: 110, low: 90, close: 105,
      volume: 50000,
    });
    expect(bar).toBeNull();
  });

  it('rejects bar with Infinity price', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: 100, high: Infinity, low: 90, close: 105,
      volume: 50000,
    });
    expect(bar).toBeNull();
  });

  it('rejects bar with -Infinity price', () => {
    const bar = sanitizeBar({
      instrumentId: 'test-001',
      timestamp: '2025-01-15T14:30:00.000Z',
      open: 100, high: 110, low: -Infinity, close: 105,
      volume: 50000,
    });
    expect(bar).toBeNull();
  });
});
