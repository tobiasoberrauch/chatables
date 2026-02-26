/**
 * Cross-Asset Correlation Engine
 *
 * Computes Pearson correlation matrices across multiple instruments over
 * configurable time windows. Designed for:
 *   - Portfolio diversification analysis
 *   - Risk monitoring (correlation regime changes)
 *   - Pairs trading signal generation
 *
 * Implementation uses a single-pass (streaming) algorithm for computing
 * means, variances, and covariances to handle large datasets efficiently
 * without requiring multiple passes over the data.
 *
 * Pearson correlation coefficient:
 *   r(X,Y) = cov(X,Y) / (stddev(X) * stddev(Y))
 *
 * Using Welford's online algorithm for numerical stability:
 *   mean_n = mean_{n-1} + (x_n - mean_{n-1}) / n
 *   M2_n   = M2_{n-1} + (x_n - mean_{n-1}) * (x_n - mean_n)
 *   var    = M2_n / (n - 1)
 *
 * For covariance we use the co-moment update:
 *   C_n(X,Y) = C_{n-1}(X,Y) + (x_n - mean_x_n) * (y_n - mean_y_{n-1})
 *   cov(X,Y) = C_n / (n - 1)
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CorrelationMatrixEntry {
  /** Row instrument label. */
  instrumentA: string;
  /** Column instrument label. */
  instrumentB: string;
  /** Pearson correlation coefficient in [-1, 1]. */
  correlation: number;
  /** Number of overlapping data points used. */
  sampleSize: number;
}

export interface CorrelationMatrix {
  /** Ordered list of instrument labels (row & column headers). */
  labels: string[];
  /**
   * Full NxN correlation matrix. matrix[i][j] = correlation between
   * labels[i] and labels[j]. matrix[i][i] = 1.0.
   */
  matrix: number[][];
  /** Sample size (number of overlapping timestamps) for each pair. */
  sampleSizes: number[][];
  /** Flat list of unique pairs with their correlations. */
  pairs: CorrelationMatrixEntry[];
}

export interface CorrelationParams {
  /**
   * Time window for correlation computation.
   * Only bars within [windowStart, windowEnd] are included.
   * If not specified, all bars are used.
   */
  windowStart?: string; // ISO 8601
  windowEnd?: string;   // ISO 8601
  /**
   * Which price field to use for returns calculation.
   * Default: 'close'.
   */
  priceField?: 'open' | 'high' | 'low' | 'close';
  /**
   * Minimum number of overlapping observations required to compute
   * a valid correlation. Pairs with fewer observations get NaN.
   * Default: 20.
   */
  minObservations?: number;
  /**
   * Whether to use log returns instead of simple returns.
   * Log returns are additive and more suitable for multi-period analysis.
   * Default: true.
   */
  useLogReturns?: boolean;
}

/** Input: one instrument's bar data with a label. */
export interface InstrumentSeries {
  label: string;         // e.g. "AAPL", "SPY", "GLD"
  bars: OHLCVBar[];
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the Pearson correlation matrix across multiple instruments.
 *
 * Algorithm:
 *   1. For each instrument, compute returns series (simple or log).
 *   2. Align returns by timestamp (inner join — only overlapping timestamps).
 *   3. Compute correlation using the streaming Welford/co-moment algorithm.
 *
 * @param series - Array of instrument bar series. Each must be sorted
 *                 chronologically (oldest first).
 * @param params - Configuration for the correlation computation.
 * @returns The full correlation matrix with labels.
 */
export function computeCorrelationMatrix(
  series: InstrumentSeries[],
  params: CorrelationParams = {},
): CorrelationMatrix {
  const {
    priceField = 'close',
    minObservations = 20,
    useLogReturns = true,
    windowStart,
    windowEnd,
  } = params;

  const n = series.length;

  if (n === 0) {
    return { labels: [], matrix: [], sampleSizes: [], pairs: [] };
  }

  if (n === 1) {
    return {
      labels: [series[0].label],
      matrix: [[1]],
      sampleSizes: [[series[0].bars.length]],
      pairs: [],
    };
  }

  // Step 1: Extract returns keyed by timestamp for each instrument
  const returnsMaps: Map<string, number>[] = series.map((s) =>
    computeReturnsMap(s.bars, priceField, useLogReturns, windowStart, windowEnd),
  );

  // Step 2: For each pair (i, j), find overlapping timestamps and compute correlation
  const labels = series.map((s) => s.label);
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const sampleSizes: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const pairs: CorrelationMatrixEntry[] = [];

  // Diagonal
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    sampleSizes[i][i] = returnsMaps[i].size;
  }

  // Upper triangle — compute and mirror to lower triangle
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { correlation, sampleSize } = streamingPearson(
        returnsMaps[i],
        returnsMaps[j],
        minObservations,
      );

      matrix[i][j] = correlation;
      matrix[j][i] = correlation;
      sampleSizes[i][j] = sampleSize;
      sampleSizes[j][i] = sampleSize;

      pairs.push({
        instrumentA: labels[i],
        instrumentB: labels[j],
        correlation,
        sampleSize,
      });
    }
  }

  return { labels, matrix, sampleSizes, pairs };
}

/**
 * Compute pairwise Pearson correlation between two return series.
 *
 * Convenience wrapper for two instruments.
 */
export function computePairwiseCorrelation(
  seriesA: InstrumentSeries,
  seriesB: InstrumentSeries,
  params: CorrelationParams = {},
): CorrelationMatrixEntry {
  const result = computeCorrelationMatrix([seriesA, seriesB], params);
  if (result.pairs.length === 0) {
    return {
      instrumentA: seriesA.label,
      instrumentB: seriesB.label,
      correlation: NaN,
      sampleSize: 0,
    };
  }
  return result.pairs[0];
}

/**
 * Compute a rolling correlation between two instruments.
 *
 * Returns correlation values computed over a sliding window of `windowSize`
 * observations, aligned by timestamp.
 */
export function computeRollingCorrelation(
  seriesA: InstrumentSeries,
  seriesB: InstrumentSeries,
  windowSize: number,
  params: Omit<CorrelationParams, 'minObservations'> = {},
): Array<{ timestamp: string; correlation: number }> {
  const {
    priceField = 'close',
    useLogReturns = true,
    windowStart,
    windowEnd,
  } = params;

  if (windowSize < 3) {
    throw new Error(`Rolling correlation windowSize must be >= 3, received: ${windowSize}`);
  }

  const returnsA = computeReturnsMap(seriesA.bars, priceField, useLogReturns, windowStart, windowEnd);
  const returnsB = computeReturnsMap(seriesB.bars, priceField, useLogReturns, windowStart, windowEnd);

  // Find overlapping timestamps, sorted chronologically
  const overlapping: Array<{ timestamp: string; a: number; b: number }> = [];
  for (const [ts, retA] of returnsA) {
    const retB = returnsB.get(ts);
    if (retB !== undefined) {
      overlapping.push({ timestamp: ts, a: retA, b: retB });
    }
  }
  overlapping.sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));

  if (overlapping.length < windowSize) {
    return [];
  }

  const results: Array<{ timestamp: string; correlation: number }> = [];

  for (let end = windowSize - 1; end < overlapping.length; end++) {
    const start = end - windowSize + 1;

    // Compute Pearson for this window
    let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
    const n = windowSize;

    for (let k = start; k <= end; k++) {
      const a = overlapping[k].a;
      const b = overlapping[k].b;
      sumA += a;
      sumB += b;
      sumAB += a * b;
      sumA2 += a * a;
      sumB2 += b * b;
    }

    const meanA = sumA / n;
    const meanB = sumB / n;
    const varA = sumA2 / n - meanA * meanA;
    const varB = sumB2 / n - meanB * meanB;
    const covAB = sumAB / n - meanA * meanB;

    const denominator = Math.sqrt(varA * varB);
    const correlation = denominator === 0 ? 0 : covAB / denominator;

    results.push({
      timestamp: overlapping[end].timestamp,
      correlation: clampCorrelation(correlation),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute returns from OHLCV bars and store in a Map keyed by timestamp.
 *
 * Returns are computed as:
 *   simple:  (price_t / price_{t-1}) - 1
 *   log:     ln(price_t / price_{t-1})
 *
 * Bars with non-positive prices are skipped.
 */
function computeReturnsMap(
  bars: OHLCVBar[],
  field: 'open' | 'high' | 'low' | 'close',
  useLog: boolean,
  windowStart?: string,
  windowEnd?: string,
): Map<string, number> {
  const returns = new Map<string, number>();

  // Filter by time window
  let filtered = bars;
  if (windowStart || windowEnd) {
    filtered = bars.filter((b) => {
      if (windowStart && b.timestamp < windowStart) return false;
      if (windowEnd && b.timestamp > windowEnd) return false;
      return true;
    });
  }

  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1][field];
    const curr = filtered[i][field];

    if (prev <= 0 || curr <= 0) continue;

    const ret = useLog
      ? Math.log(curr / prev)
      : (curr / prev) - 1;

    returns.set(filtered[i].timestamp, ret);
  }

  return returns;
}

/**
 * Streaming Pearson correlation using Welford's online algorithm.
 *
 * This performs a single pass over the overlapping data points.
 */
function streamingPearson(
  returnsA: Map<string, number>,
  returnsB: Map<string, number>,
  minObservations: number,
): { correlation: number; sampleSize: number } {
  // Iterate over the smaller map for efficiency
  const [smaller, larger] = returnsA.size <= returnsB.size
    ? [returnsA, returnsB]
    : [returnsB, returnsA];

  let n = 0;
  let meanA = 0;
  let meanB = 0;
  let m2A = 0;    // sum of squared deviations for A
  let m2B = 0;    // sum of squared deviations for B
  let coMoment = 0; // co-moment for covariance

  for (const [ts, valSmaller] of smaller) {
    const valLarger = larger.get(ts);
    if (valLarger === undefined) continue;

    // Determine which value is A and which is B
    const a = returnsA.size <= returnsB.size ? valSmaller : valLarger;
    const b = returnsA.size <= returnsB.size ? valLarger : valSmaller;

    n++;
    const dA = a - meanA;
    const dB = b - meanB;
    meanA += dA / n;
    meanB += dB / n;
    const dA2 = a - meanA; // updated delta
    const dB2 = b - meanB;
    m2A += dA * dA2;
    m2B += dB * dB2;
    coMoment += dA * dB2; // cross-moment update
  }

  if (n < minObservations) {
    return { correlation: NaN, sampleSize: n };
  }

  const varA = m2A / (n - 1);
  const varB = m2B / (n - 1);
  const covariance = coMoment / (n - 1);

  const denominator = Math.sqrt(varA * varB);
  if (denominator === 0) {
    return { correlation: 0, sampleSize: n };
  }

  const correlation = clampCorrelation(covariance / denominator);
  return { correlation, sampleSize: n };
}

/**
 * Clamp correlation to [-1, 1] to handle floating-point rounding errors.
 */
function clampCorrelation(r: number): number {
  if (Number.isNaN(r)) return NaN;
  return Math.min(1, Math.max(-1, r));
}
