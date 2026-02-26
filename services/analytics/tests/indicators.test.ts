import { describe, it, expect } from 'vitest';
import { computeSMA } from '../src/indicators/sma';
import { computeEMA, emaFromValues } from '../src/indicators/ema';
import { computeRSI } from '../src/indicators/rsi';
import { computeMACD } from '../src/indicators/macd';
import { computeVWAP } from '../src/indicators/vwap';
import type { OHLCVBar } from '../../../shared/src/types/instrument';
import { BarSize } from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Helper: create a minimal OHLCVBar from a close price
// ---------------------------------------------------------------------------

let barIndex = 0;

function makeBar(close: number, overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  barIndex++;
  return {
    instrumentId: 'TEST',
    timestamp: `2025-01-${String(barIndex).padStart(2, '0')}T16:00:00.000Z`,
    open: overrides.open ?? close,
    high: overrides.high ?? close,
    low: overrides.low ?? close,
    close,
    volume: overrides.volume ?? 1000,
    vwap: overrides.vwap ?? close,
    trades: overrides.trades ?? 100,
    barSize: overrides.barSize ?? BarSize.DAY_1,
    isAdjusted: overrides.isAdjusted ?? false,
    source: overrides.source ?? 'test',
  };
}

function makeBars(closes: number[]): OHLCVBar[] {
  barIndex = 0; // Reset so timestamps start from 01
  return closes.map((c) => makeBar(c));
}

function makeBarsWithVolume(
  data: Array<{ high: number; low: number; close: number; volume: number }>,
): OHLCVBar[] {
  barIndex = 0;
  return data.map((d) =>
    makeBar(d.close, { high: d.high, low: d.low, volume: d.volume }),
  );
}

// ============================================================================
// SMA Tests
// ============================================================================

describe('SMA (Simple Moving Average)', () => {
  it('computes SMA correctly for [10,11,12,13,14] period 3 → [11,12,13]', () => {
    const bars = makeBars([10, 11, 12, 13, 14]);
    const result = computeSMA(bars, { period: 3 });

    expect(result.indicator).toBe('SMA');
    expect(result.params.period).toBe(3);
    expect(result.inputLength).toBe(5);
    expect(result.values).toHaveLength(3);

    expect(result.values[0].value).toBeCloseTo(11, 10); // (10+11+12)/3
    expect(result.values[1].value).toBeCloseTo(12, 10); // (11+12+13)/3
    expect(result.values[2].value).toBeCloseTo(13, 10); // (12+13+14)/3
  });

  it('returns empty array for empty input', () => {
    const result = computeSMA([], { period: 3 });
    expect(result.values).toHaveLength(0);
    expect(result.inputLength).toBe(0);
  });

  it('returns empty array when period > length', () => {
    const bars = makeBars([10, 11]);
    const result = computeSMA(bars, { period: 5 });
    expect(result.values).toHaveLength(0);
    expect(result.inputLength).toBe(2);
  });

  it('computes single value when period equals length', () => {
    const bars = makeBars([10, 20, 30]);
    const result = computeSMA(bars, { period: 3 });
    expect(result.values).toHaveLength(1);
    expect(result.values[0].value).toBeCloseTo(20, 10);
  });

  it('period 1 returns the close prices themselves', () => {
    const bars = makeBars([5, 10, 15]);
    const result = computeSMA(bars, { period: 1 });
    expect(result.values).toHaveLength(3);
    expect(result.values[0].value).toBe(5);
    expect(result.values[1].value).toBe(10);
    expect(result.values[2].value).toBe(15);
  });

  it('throws on invalid period (0)', () => {
    expect(() => computeSMA([], { period: 0 })).toThrow();
  });

  it('throws on negative period', () => {
    expect(() => computeSMA([], { period: -1 })).toThrow();
  });

  it('throws on non-integer period', () => {
    expect(() => computeSMA([], { period: 2.5 })).toThrow();
  });

  it('throws on NaN period', () => {
    expect(() => computeSMA([], { period: NaN })).toThrow();
  });

  it('preserves timestamps from input bars', () => {
    const bars = makeBars([10, 20, 30, 40]);
    const result = computeSMA(bars, { period: 2 });
    // The first SMA value corresponds to bar index 1 (period - 1 = 1)
    expect(result.values[0].timestamp).toBe(bars[1].timestamp);
    expect(result.values[1].timestamp).toBe(bars[2].timestamp);
    expect(result.values[2].timestamp).toBe(bars[3].timestamp);
  });
});

// ============================================================================
// EMA Tests
// ============================================================================

describe('EMA (Exponential Moving Average)', () => {
  it('seeds with SMA of first `period` values', () => {
    const bars = makeBars([10, 20, 30, 40, 50]);
    const result = computeEMA(bars, { period: 3 });

    // Seed = SMA of [10, 20, 30] = 20
    expect(result.values[0].value).toBeCloseTo(20, 10);
  });

  it('computes known 5-period EMA values', () => {
    // Known data: [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29]
    const closes = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
    const bars = makeBars(closes);
    const result = computeEMA(bars, { period: 5 });

    // k = 2/(5+1) = 1/3
    const k = 2 / 6;
    // Seed = SMA of first 5 = (22.27+22.19+22.08+22.17+22.18)/5 = 22.178
    const seed = (22.27 + 22.19 + 22.08 + 22.17 + 22.18) / 5;
    expect(result.values[0].value).toBeCloseTo(seed, 6);

    // EMA[1] = 22.13 * k + seed * (1-k)
    const ema1 = 22.13 * k + seed * (1 - k);
    expect(result.values[1].value).toBeCloseTo(ema1, 6);

    // EMA[2] = 22.23 * k + ema1 * (1-k)
    const ema2 = 22.23 * k + ema1 * (1 - k);
    expect(result.values[2].value).toBeCloseTo(ema2, 6);

    expect(result.smoothingFactor).toBeCloseTo(k, 10);
    expect(result.values).toHaveLength(6); // 10 - 5 + 1
  });

  it('converges toward the price when all closes are the same', () => {
    const bars = makeBars([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
    const result = computeEMA(bars, { period: 3 });

    // All values should be exactly 50
    for (const v of result.values) {
      expect(v.value).toBeCloseTo(50, 10);
    }
  });

  it('returns empty for empty input', () => {
    const result = computeEMA([], { period: 3 });
    expect(result.values).toHaveLength(0);
  });

  it('returns empty when period > length', () => {
    const bars = makeBars([10]);
    const result = computeEMA(bars, { period: 5 });
    expect(result.values).toHaveLength(0);
  });

  it('throws on invalid period', () => {
    expect(() => computeEMA([], { period: 0 })).toThrow();
  });

  it('emaFromValues helper produces consistent results', () => {
    const data = [10, 20, 30, 40, 50];
    const emaVals = emaFromValues(data, 3);
    const bars = makeBars(data);
    const result = computeEMA(bars, { period: 3 });

    expect(emaVals).toHaveLength(result.values.length);
    for (let i = 0; i < emaVals.length; i++) {
      expect(emaVals[i]).toBeCloseTo(result.values[i].value, 10);
    }
  });
});

// ============================================================================
// RSI Tests
// ============================================================================

describe('RSI (Relative Strength Index)', () => {
  it('returns RSI 100 when all price changes are gains', () => {
    // Strictly increasing prices: all gains, no losses
    const bars = makeBars([10, 11, 12, 13, 14, 15]);
    const result = computeRSI(bars, { period: 3 });

    // With only gains, RSI should be 100
    expect(result.values.length).toBeGreaterThan(0);
    expect(result.values[0].value).toBe(100);
  });

  it('returns RSI 0 when all price changes are losses', () => {
    // Strictly decreasing prices: all losses, no gains
    const bars = makeBars([15, 14, 13, 12, 11, 10]);
    const result = computeRSI(bars, { period: 3 });

    expect(result.values.length).toBeGreaterThan(0);
    expect(result.values[0].value).toBe(0);
  });

  it('returns RSI ~50 when gains and losses are balanced', () => {
    // Alternating: +1, -1, +1, -1 ... (equal average gain and loss)
    const bars = makeBars([10, 11, 10, 11, 10, 11, 10, 11, 10]);
    const result = computeRSI(bars, { period: 4 });

    expect(result.values.length).toBeGreaterThan(0);
    // With balanced gains/losses, RSI should be approximately 50
    for (const v of result.values) {
      expect(v.value).toBeGreaterThanOrEqual(45);
      expect(v.value).toBeLessThanOrEqual(55);
    }
  });

  it('returns RSI 50 when no price changes occur', () => {
    const bars = makeBars([100, 100, 100, 100, 100]);
    const result = computeRSI(bars, { period: 3 });

    expect(result.values.length).toBeGreaterThan(0);
    // Both avgGain and avgLoss are 0 → RSI = 50
    expect(result.values[0].value).toBe(50);
  });

  it('RSI is always in range [0, 100]', () => {
    const closes = [100, 110, 95, 120, 80, 130, 70, 140, 60, 150, 50];
    const bars = makeBars(closes);
    const result = computeRSI(bars, { period: 3 });

    for (const v of result.values) {
      expect(v.value).toBeGreaterThanOrEqual(0);
      expect(v.value).toBeLessThanOrEqual(100);
    }
  });

  it('throws on period < 1', () => {
    expect(() => computeRSI([], { period: 0 })).toThrow();
  });

  it('returns empty when insufficient bars (needs period + 1)', () => {
    const bars = makeBars([10, 11, 12]);
    const result = computeRSI(bars, { period: 3 });
    // Need 3+1=4 bars, only have 3
    expect(result.values).toHaveLength(0);
  });

  it('returns one value when bars.length == period + 1', () => {
    const bars = makeBars([10, 12, 14, 16]); // 4 bars, period=3
    const result = computeRSI(bars, { period: 3 });
    expect(result.values).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    const result = computeRSI([], { period: 14 });
    expect(result.values).toHaveLength(0);
  });
});

// ============================================================================
// MACD Tests
// ============================================================================

describe('MACD (Moving Average Convergence Divergence)', () => {
  it('MACD line equals EMA(fast) - EMA(slow)', () => {
    // Generate enough bars for default MACD (fast=12, slow=26, signal=9)
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) {
      closes.push(100 + Math.sin(i * 0.5) * 10);
    }
    const bars = makeBars(closes);

    const result = computeMACD(bars);

    // Independently compute fast and slow EMA
    const fastEma = emaFromValues(closes, 12);
    const slowEma = emaFromValues(closes, 26);

    // MACD line starts at index (slowPeriod - 1) = 25
    // fastEma starts at index 11 (fastPeriod - 1)
    // At bar index 25: fastEma[25-11] = fastEma[14], slowEma[0]
    for (let j = 0; j < slowEma.length; j++) {
      const fastIdx = (26 - 12) + j; // fastOffset + j
      const expectedMACD = fastEma[fastIdx] - slowEma[j];
      expect(result.macdLine[j].value).toBeCloseTo(expectedMACD, 8);
    }
  });

  it('histogram equals MACD line minus signal line', () => {
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) {
      closes.push(100 + i * 0.5 + Math.sin(i) * 5);
    }
    const bars = makeBars(closes);

    const result = computeMACD(bars);

    for (const v of result.values) {
      expect(v.histogram).toBeCloseTo(v.macd - v.signal, 10);
    }
  });

  it('throws when fastPeriod >= slowPeriod', () => {
    expect(() =>
      computeMACD(makeBars([1, 2, 3]), { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 }),
    ).toThrow();
  });

  it('throws on non-positive periods', () => {
    expect(() =>
      computeMACD(makeBars([]), { fastPeriod: 0, slowPeriod: 26, signalPeriod: 9 }),
    ).toThrow();
  });

  it('returns empty macdLine when insufficient bars for slow EMA', () => {
    const bars = makeBars([1, 2, 3, 4, 5]); // Only 5 bars, need 26
    const result = computeMACD(bars);
    expect(result.macdLine).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it('returns empty values when insufficient bars for signal line', () => {
    // Need slowPeriod + signalPeriod - 1 = 34 bars for full output
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i);
    const bars = makeBars(closes);

    const result = computeMACD(bars);
    // macdLine should exist (30 >= 26), but values may be empty
    // macdLine length = 30 - 26 + 1 = 5, need signalPeriod=9 for signal, so values empty
    expect(result.macdLine.length).toBeGreaterThan(0);
    expect(result.values).toHaveLength(0);
  });

  it('uses custom parameters', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(50 + i);
    const bars = makeBars(closes);

    const result = computeMACD(bars, { fastPeriod: 5, slowPeriod: 10, signalPeriod: 3 });
    expect(result.params.fastPeriod).toBe(5);
    expect(result.params.slowPeriod).toBe(10);
    expect(result.params.signalPeriod).toBe(3);
    // Should have values since 30 >= 10 + 3 - 1 = 12
    expect(result.values.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// VWAP Tests
// ============================================================================

describe('VWAP (Volume Weighted Average Price)', () => {
  it('computes VWAP as cumulative(TP * volume) / cumulative(volume)', () => {
    const data = [
      { high: 110, low: 100, close: 105, volume: 1000 },
      { high: 115, low: 102, close: 110, volume: 2000 },
      { high: 120, low: 108, close: 112, volume: 1500 },
    ];
    const bars = makeBarsWithVolume(data);
    // All same day timestamps, so no session reset

    const result = computeVWAP(bars);

    // Bar 0: TP = (110+100+105)/3 = 105, cumPV = 105*1000 = 105000, cumVol = 1000
    //   VWAP = 105000/1000 = 105
    const tp0 = (110 + 100 + 105) / 3;
    expect(result.values[0].vwap).toBeCloseTo(tp0, 6);

    // Bar 1: TP = (115+102+110)/3 = 109, cumPV = 105000 + 109*2000 = 323000, cumVol = 3000
    //   VWAP = 323000/3000 ≈ 107.667
    const tp1 = (115 + 102 + 110) / 3;
    const cumPV1 = tp0 * 1000 + tp1 * 2000;
    const cumVol1 = 3000;
    expect(result.values[1].vwap).toBeCloseTo(cumPV1 / cumVol1, 6);

    // Bar 2: TP = (120+108+112)/3 = 113.333
    const tp2 = (120 + 108 + 112) / 3;
    const cumPV2 = cumPV1 + tp2 * 1500;
    const cumVol2 = 4500;
    expect(result.values[2].vwap).toBeCloseTo(cumPV2 / cumVol2, 6);
  });

  it('returns empty for empty input', () => {
    const result = computeVWAP([]);
    expect(result.values).toHaveLength(0);
    expect(result.inputLength).toBe(0);
  });

  it('handles single bar', () => {
    const bars = makeBarsWithVolume([{ high: 100, low: 90, close: 95, volume: 500 }]);
    const result = computeVWAP(bars);

    expect(result.values).toHaveLength(1);
    const tp = (100 + 90 + 95) / 3;
    expect(result.values[0].vwap).toBeCloseTo(tp, 6);
  });

  it('resets VWAP on session boundary (date change)', () => {
    barIndex = 0;
    const bars: OHLCVBar[] = [
      makeBar(100, { high: 105, low: 95, volume: 1000, timestamp: '2025-01-01T10:00:00.000Z' } as any),
      makeBar(110, { high: 115, low: 105, volume: 2000, timestamp: '2025-01-01T11:00:00.000Z' } as any),
      makeBar(120, { high: 125, low: 115, volume: 1500, timestamp: '2025-01-02T10:00:00.000Z' } as any),
    ];
    // Fix timestamps manually
    bars[0].timestamp = '2025-01-01T10:00:00.000Z';
    bars[1].timestamp = '2025-01-01T11:00:00.000Z';
    bars[2].timestamp = '2025-01-02T10:00:00.000Z';

    const result = computeVWAP(bars);

    // Bar 2 is a new session, so VWAP should reset
    const tp2 = (125 + 115 + 120) / 3;
    // Since it's the first bar in a new session, VWAP = tp2 (only one bar of volume)
    expect(result.values[2].vwap).toBeCloseTo(tp2, 6);
  });

  it('handles zero volume bars (VWAP carries forward)', () => {
    const data = [
      { high: 110, low: 100, close: 105, volume: 1000 },
      { high: 115, low: 102, close: 110, volume: 0 },
      { high: 120, low: 108, close: 112, volume: 2000 },
    ];
    const bars = makeBarsWithVolume(data);
    const result = computeVWAP(bars);

    // Bar 0: VWAP = TP0
    const tp0 = (110 + 100 + 105) / 3;
    expect(result.values[0].vwap).toBeCloseTo(tp0, 6);

    // Bar 1: zero volume, cumVol still 1000, cumPV unchanged
    // VWAP stays at tp0
    expect(result.values[1].vwap).toBeCloseTo(tp0, 6);
  });

  it('includes standard deviation bands when requested', () => {
    const data = [
      { high: 110, low: 100, close: 105, volume: 1000 },
      { high: 115, low: 102, close: 110, volume: 2000 },
    ];
    const bars = makeBarsWithVolume(data);
    const result = computeVWAP(bars, { includeBands: true });

    expect(result.params.includeBands).toBe(true);
    expect(result.values[0].upperBands).toBeDefined();
    expect(result.values[0].lowerBands).toBeDefined();
    expect(result.values[0].upperBands!).toHaveLength(3);
    expect(result.values[0].lowerBands!).toHaveLength(3);

    // Upper bands should be above VWAP, lower below
    for (let i = 0; i < 3; i++) {
      expect(result.values[1].upperBands![i]).toBeGreaterThanOrEqual(result.values[1].vwap);
      expect(result.values[1].lowerBands![i]).toBeLessThanOrEqual(result.values[1].vwap);
    }
  });
});

// ============================================================================
// Edge Cases (cross-indicator)
// ============================================================================

describe('Indicator Edge Cases', () => {
  it('all indicators handle a single bar gracefully', () => {
    const bars = makeBars([100]);

    const smaResult = computeSMA(bars, { period: 1 });
    expect(smaResult.values).toHaveLength(1);
    expect(smaResult.values[0].value).toBe(100);

    const emaResult = computeEMA(bars, { period: 1 });
    expect(emaResult.values).toHaveLength(1);
    expect(emaResult.values[0].value).toBe(100);

    // RSI needs period+1 bars, so period=1 with 1 bar → 0 values
    const rsiResult = computeRSI(bars, { period: 1 });
    expect(rsiResult.values).toHaveLength(0);

    const vwapResult = computeVWAP(bars);
    expect(vwapResult.values).toHaveLength(1);
  });

  it('all indicators handle empty arrays', () => {
    expect(computeSMA([], { period: 3 }).values).toHaveLength(0);
    expect(computeEMA([], { period: 3 }).values).toHaveLength(0);
    expect(computeRSI([], { period: 3 }).values).toHaveLength(0);
    expect(computeMACD([]).values).toHaveLength(0);
    expect(computeVWAP([]).values).toHaveLength(0);
  });

  it('SMA and EMA with period=1 yield close prices', () => {
    const bars = makeBars([10, 20, 30]);

    const sma = computeSMA(bars, { period: 1 });
    const ema = computeEMA(bars, { period: 1 });

    for (let i = 0; i < 3; i++) {
      expect(sma.values[i].value).toBe(bars[i].close);
      expect(ema.values[i].value).toBe(bars[i].close);
    }
  });

  it('handles very large values without overflow', () => {
    const bars = makeBars([1e12, 1.1e12, 1.2e12, 1.3e12, 1.4e12]);
    const smaResult = computeSMA(bars, { period: 3 });
    expect(smaResult.values[0].value).toBeCloseTo(1.1e12, -2);
    expect(Number.isFinite(smaResult.values[0].value)).toBe(true);
  });

  it('handles very small values (penny stocks)', () => {
    const bars = makeBars([0.001, 0.002, 0.003, 0.004, 0.005]);
    const smaResult = computeSMA(bars, { period: 3 });
    expect(smaResult.values[0].value).toBeCloseTo(0.002, 10);
  });
});
