/**
 * Correlation Engine
 *
 * Computes pairwise Pearson correlation coefficients for financial time series.
 * Used for portfolio diversification analysis, pair trading, and risk management.
 *
 * Pearson correlation:
 *   r = cov(X, Y) / (stddev(X) * stddev(Y))
 *
 * Where:
 *   cov(X, Y) = (1/n) * sum((x_i - mean_x) * (y_i - mean_y))
 *   stddev(X) = sqrt((1/n) * sum((x_i - mean_x)^2))
 */

/**
 * Compute the Pearson correlation coefficient between two numeric series.
 *
 * Both series must have the same length. Returns NaN for degenerate cases
 * (e.g., constant series where standard deviation is zero, or series with
 * fewer than 2 data points).
 *
 * @param seriesA - First data series
 * @param seriesB - Second data series
 * @returns Pearson correlation coefficient in range [-1, 1], or NaN
 */
export function pearsonCorrelation(seriesA: number[], seriesB: number[]): number {
  if (seriesA.length !== seriesB.length) {
    throw new Error(
      `Series must have equal length. Got ${seriesA.length} and ${seriesB.length}`,
    );
  }

  const n = seriesA.length;

  if (n < 2) {
    return NaN;
  }

  // Compute means
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += seriesA[i];
    sumB += seriesB[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  // Compute covariance and standard deviations
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = seriesA[i] - meanA;
    const dB = seriesB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const stdA = Math.sqrt(varA);
  const stdB = Math.sqrt(varB);

  // If either series is constant (zero std dev), correlation is undefined
  if (stdA === 0 || stdB === 0) {
    return NaN;
  }

  return cov / (stdA * stdB);
}

export interface CorrelationMatrixEntry {
  instrumentIdA: string;
  instrumentIdB: string;
  correlation: number;
  dataPoints: number;
}

/**
 * Compute a full pairwise correlation matrix for multiple instruments.
 *
 * @param seriesMap - Map of instrumentId to price/return series
 * @returns Array of pairwise correlation entries (upper triangle including diagonal)
 */
export function correlationMatrix(
  seriesMap: Record<string, number[]>,
): CorrelationMatrixEntry[] {
  const instrumentIds = Object.keys(seriesMap);
  const results: CorrelationMatrixEntry[] = [];

  for (let i = 0; i < instrumentIds.length; i++) {
    for (let j = i; j < instrumentIds.length; j++) {
      const idA = instrumentIds[i];
      const idB = instrumentIds[j];
      const a = seriesMap[idA];
      const b = seriesMap[idB];

      // Align to minimum length
      const minLen = Math.min(a.length, b.length);
      const sliceA = a.slice(a.length - minLen);
      const sliceB = b.slice(b.length - minLen);

      results.push({
        instrumentIdA: idA,
        instrumentIdB: idB,
        correlation: pearsonCorrelation(sliceA, sliceB),
        dataPoints: minLen,
      });
    }
  }

  return results;
}

/**
 * Compute rolling correlation between two series.
 *
 * @param seriesA - First data series
 * @param seriesB - Second data series
 * @param windowSize - Rolling window size
 * @returns Array of rolling correlation values, length = max(0, n - windowSize + 1)
 */
export function rollingCorrelation(
  seriesA: number[],
  seriesB: number[],
  windowSize: number,
): number[] {
  if (seriesA.length !== seriesB.length) {
    throw new Error(
      `Series must have equal length. Got ${seriesA.length} and ${seriesB.length}`,
    );
  }

  const n = seriesA.length;
  if (n < windowSize || windowSize < 2) return [];

  const results: number[] = [];

  for (let i = 0; i <= n - windowSize; i++) {
    const windowA = seriesA.slice(i, i + windowSize);
    const windowB = seriesB.slice(i, i + windowSize);
    results.push(pearsonCorrelation(windowA, windowB));
  }

  return results;
}
