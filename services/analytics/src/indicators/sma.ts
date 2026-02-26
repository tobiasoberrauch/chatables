/**
 * Simple Moving Average (SMA) Indicator
 *
 * Computes the arithmetic mean of closing prices over a rolling window.
 * SMA_t = (1/N) * sum(close[t-N+1] ... close[t])
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';

/** A single computed indicator data point with its timestamp. */
export interface IndicatorDataPoint {
  timestamp: string;
  value: number;
}

export interface SMAParams {
  /** Number of periods for the moving average. Must be >= 1. */
  period: number;
}

export interface SMAResult {
  indicator: 'SMA';
  params: SMAParams;
  /** Number of input bars provided. */
  inputLength: number;
  /** Computed SMA values. Length = max(0, inputLength - period + 1). */
  values: IndicatorDataPoint[];
}

/**
 * Compute the Simple Moving Average over an array of OHLCV bars.
 *
 * The bars are expected to be sorted chronologically (oldest first).
 * Returns one SMA value for each bar where a full window is available,
 * starting at index (period - 1).
 *
 * @throws {Error} If period < 1 or is not a finite integer.
 */
export function computeSMA(bars: OHLCVBar[], params: SMAParams): SMAResult {
  const { period } = params;

  if (!Number.isFinite(period) || !Number.isInteger(period) || period < 1) {
    throw new Error(`SMA period must be a positive integer, received: ${period}`);
  }

  if (bars.length === 0 || bars.length < period) {
    return {
      indicator: 'SMA',
      params,
      inputLength: bars.length,
      values: [],
    };
  }

  const values: IndicatorDataPoint[] = [];

  // Compute initial window sum
  let windowSum = 0;
  for (let i = 0; i < period; i++) {
    windowSum += bars[i].close;
  }
  values.push({
    timestamp: bars[period - 1].timestamp,
    value: windowSum / period,
  });

  // Slide the window forward: subtract the element leaving, add the new one.
  // This avoids O(n*period) re-summation and minimises floating-point drift
  // compared to a naive approach while staying simple.
  for (let i = period; i < bars.length; i++) {
    windowSum += bars[i].close - bars[i - period].close;
    values.push({
      timestamp: bars[i].timestamp,
      value: windowSum / period,
    });
  }

  return {
    indicator: 'SMA',
    params,
    inputLength: bars.length,
    values,
  };
}
