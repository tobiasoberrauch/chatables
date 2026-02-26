import { describe, it, expect } from 'vitest';
import {
  computeCorrelationMatrix,
  computePairwiseCorrelation,
  computeRollingCorrelation,
} from '../src/correlation/cross-asset';
import type { InstrumentSeries } from '../src/correlation/cross-asset';
import type { OHLCVBar } from '../../../shared/src/types/instrument';
import { BarSize } from '../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Helper: create time-series bars from close prices
// ---------------------------------------------------------------------------

function makeSeriesBars(closes: number[], startDate: string = '2025-01-01'): OHLCVBar[] {
  return closes.map((close, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return {
      instrumentId: 'TEST',
      timestamp: d.toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      vwap: close,
      trades: 100,
      barSize: BarSize.DAY_1,
      isAdjusted: false,
      source: 'test',
    };
  });
}

function makeSeries(label: string, closes: number[]): InstrumentSeries {
  return { label, bars: makeSeriesBars(closes) };
}

// ============================================================================
// Pairwise Correlation
// ============================================================================

describe('Pairwise Correlation', () => {
  it('identical series → correlation 1.0', () => {
    const closes = [100, 102, 104, 103, 106, 108, 107, 110, 112, 115,
                     118, 120, 119, 122, 124, 123, 126, 128, 130, 132,
                     135, 137];
    const seriesA = makeSeries('A', closes);
    const seriesB = makeSeries('B', closes);

    const result = computePairwiseCorrelation(seriesA, seriesB, { minObservations: 5 });
    expect(result.correlation).toBeCloseTo(1.0, 6);
  });

  it('perfectly inverted series → correlation -1.0', () => {
    // B = 200 - A, so when A goes up, B goes down by the same amount
    // Log returns of B: ln(200-A[i] / 200-A[i-1])
    // For simple returns to be perfectly negative, we use: B = -A + const
    // But prices must be positive... use a transformation that creates opposite returns.
    // If A has simple returns r, B has simple returns -r:
    //   B[i] = B[i-1] * (1 - r[i])  where r[i] = A[i]/A[i-1] - 1

    const closesA = [100, 110, 105, 115, 108, 120, 112, 125, 118, 130,
                      122, 135, 128, 140, 132, 145, 138, 150, 142, 155,
                      148, 160];
    const closesB: number[] = [100];
    for (let i = 1; i < closesA.length; i++) {
      const retA = closesA[i] / closesA[i - 1] - 1;
      closesB.push(closesB[i - 1] * (1 - retA));
    }

    const seriesA = makeSeries('A', closesA);
    const seriesB = makeSeries('B', closesB);

    const result = computePairwiseCorrelation(seriesA, seriesB, {
      minObservations: 5,
      useLogReturns: false, // Use simple returns for perfect inverse
    });
    expect(result.correlation).toBeCloseTo(-1.0, 4);
  });

  it('returns NaN when insufficient overlapping observations', () => {
    const seriesA = makeSeries('A', [100, 101, 102]);
    const seriesB = makeSeries('B', [200, 201, 202]);

    const result = computePairwiseCorrelation(seriesA, seriesB, { minObservations: 20 });
    expect(result.correlation).toBeNaN();
  });
});

// ============================================================================
// Correlation Matrix
// ============================================================================

describe('Correlation Matrix', () => {
  it('diagonal entries are 1.0 (self-correlation)', () => {
    const data: InstrumentSeries[] = [
      makeSeries('AAPL', [100, 102, 104, 106, 108, 110, 112, 114, 116, 118,
                           120, 122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 142]),
      makeSeries('GOOG', [200, 198, 202, 197, 205, 203, 208, 206, 210, 209,
                           215, 212, 218, 216, 220, 219, 225, 222, 228, 226, 230, 232]),
      makeSeries('SPY', [400, 402, 401, 405, 403, 408, 406, 410, 409, 412,
                          411, 415, 413, 418, 416, 420, 419, 422, 421, 425, 424, 428]),
    ];

    const result = computeCorrelationMatrix(data, { minObservations: 5 });

    expect(result.labels).toEqual(['AAPL', 'GOOG', 'SPY']);
    expect(result.matrix).toHaveLength(3);

    // Diagonal must be 1.0
    for (let i = 0; i < 3; i++) {
      expect(result.matrix[i][i]).toBe(1.0);
    }
  });

  it('matrix is symmetric: matrix[i][j] === matrix[j][i]', () => {
    const data: InstrumentSeries[] = [
      makeSeries('A', [100, 105, 102, 108, 104, 110, 106, 112, 108, 115,
                        110, 118, 112, 120, 114, 122, 116, 125, 118, 128, 120, 130]),
      makeSeries('B', [50, 52, 51, 54, 53, 55, 54, 57, 56, 58,
                        57, 60, 59, 62, 61, 63, 62, 65, 64, 66, 65, 68]),
      makeSeries('C', [300, 298, 302, 296, 304, 294, 306, 292, 308, 290,
                        310, 288, 312, 286, 314, 284, 316, 282, 318, 280, 320, 278]),
    ];

    const result = computeCorrelationMatrix(data, { minObservations: 5 });

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(result.matrix[i][j]).toBeCloseTo(result.matrix[j][i], 10);
      }
    }
  });

  it('constant series → correlation 0 (zero variance)', () => {
    const constant = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                       100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const varying = [100, 105, 102, 108, 104, 110, 106, 112, 108, 115,
                      110, 118, 112, 120, 114, 122, 116, 125, 118, 128, 120, 130];

    const data: InstrumentSeries[] = [
      makeSeries('CONST', constant),
      makeSeries('VARY', varying),
    ];

    const result = computeCorrelationMatrix(data, { minObservations: 2 });

    // Constant series has zero returns → zero variance → correlation = 0
    if (result.pairs.length > 0) {
      expect(result.pairs[0].correlation).toBe(0);
    }
  });

  it('handles empty input', () => {
    const result = computeCorrelationMatrix([]);
    expect(result.labels).toHaveLength(0);
    expect(result.matrix).toHaveLength(0);
  });

  it('handles single instrument', () => {
    const data: InstrumentSeries[] = [
      makeSeries('ONLY', [100, 110, 105, 115, 120]),
    ];
    const result = computeCorrelationMatrix(data);
    expect(result.labels).toEqual(['ONLY']);
    expect(result.matrix).toEqual([[1]]);
    expect(result.pairs).toHaveLength(0);
  });

  it('correlation values are in range [-1, 1]', () => {
    const data: InstrumentSeries[] = [
      makeSeries('A', [100, 102, 99, 105, 97, 110, 95, 115, 93, 120,
                        91, 125, 89, 130, 87, 135, 85, 140, 83, 145, 81, 150]),
      makeSeries('B', [50, 48, 53, 46, 55, 44, 57, 42, 59, 40,
                        61, 38, 63, 36, 65, 34, 67, 32, 69, 30, 71, 28]),
    ];

    const result = computeCorrelationMatrix(data, { minObservations: 5 });

    for (const pair of result.pairs) {
      if (!isNaN(pair.correlation)) {
        expect(pair.correlation).toBeGreaterThanOrEqual(-1);
        expect(pair.correlation).toBeLessThanOrEqual(1);
      }
    }
  });

  it('pairs list contains unique pairs only (no duplicates, no self-pairs)', () => {
    const data: InstrumentSeries[] = [
      makeSeries('X', [100, 102, 104, 103, 106, 108, 107, 110, 112, 115,
                        118, 120, 119, 122, 124, 123, 126, 128, 130, 132, 135, 137]),
      makeSeries('Y', [50, 52, 51, 54, 53, 55, 54, 57, 56, 58,
                        57, 60, 59, 62, 61, 63, 62, 65, 64, 66, 65, 68]),
      makeSeries('Z', [300, 302, 301, 305, 303, 308, 306, 310, 309, 312,
                        311, 315, 313, 318, 316, 320, 319, 322, 321, 325, 324, 328]),
    ];

    const result = computeCorrelationMatrix(data, { minObservations: 5 });

    // 3 instruments → 3 unique pairs: (X,Y), (X,Z), (Y,Z)
    expect(result.pairs).toHaveLength(3);

    // No self-pairs
    for (const pair of result.pairs) {
      expect(pair.instrumentA).not.toBe(pair.instrumentB);
    }
  });
});

// ============================================================================
// Rolling Correlation
// ============================================================================

describe('Rolling Correlation', () => {
  it('returns values for sufficient data with matching timestamps', () => {
    const closesA = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118];
    const closesB = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59];

    const seriesA = makeSeries('A', closesA);
    const seriesB = makeSeries('B', closesB);

    const results = computeRollingCorrelation(seriesA, seriesB, 5, { minObservations: 3 } as any);
    expect(results.length).toBeGreaterThan(0);

    // Both monotonically increasing → high positive correlation in each window
    for (const r of results) {
      expect(r.correlation).toBeGreaterThan(0.9);
    }
  });

  it('throws for windowSize < 3', () => {
    const seriesA = makeSeries('A', [100, 101, 102]);
    const seriesB = makeSeries('B', [200, 201, 202]);
    expect(() => computeRollingCorrelation(seriesA, seriesB, 2)).toThrow();
  });

  it('returns empty when insufficient overlapping data', () => {
    const seriesA = makeSeries('A', [100, 101]);
    const seriesB = makeSeries('B', [200, 201]);
    const results = computeRollingCorrelation(seriesA, seriesB, 5);
    expect(results).toHaveLength(0);
  });
});
