/**
 * Exponential Moving Average (EMA) Indicator
 *
 * The EMA gives more weight to recent prices via an exponential smoothing factor.
 *
 * Smoothing factor (multiplier):
 *   k = 2 / (period + 1)
 *
 * Calculation:
 *   EMA_0 = SMA of first `period` bars (seed value)
 *   EMA_t = close_t * k + EMA_{t-1} * (1 - k)
 *
 * This implementation uses the standard SMA-seed approach used by most
 * charting platforms (TradingView, Bloomberg, etc.).
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';
import type { IndicatorDataPoint } from './sma';

export interface EMAParams {
  /** Number of periods. Must be >= 1. */
  period: number;
}

export interface EMAResult {
  indicator: 'EMA';
  params: EMAParams;
  inputLength: number;
  /** Smoothing multiplier k = 2 / (period + 1). */
  smoothingFactor: number;
  /**
   * Computed EMA values.
   * The first value corresponds to bar at index (period - 1) and is the SMA seed.
   * Subsequent values use exponential smoothing.
   * Length = max(0, inputLength - period + 1).
   */
  values: IndicatorDataPoint[];
}

/**
 * Compute the Exponential Moving Average over an array of OHLCV bars.
 *
 * Bars must be sorted chronologically (oldest first).
 *
 * @throws {Error} If period < 1 or is not a finite integer.
 */
export function computeEMA(bars: OHLCVBar[], params: EMAParams): EMAResult {
  const { period } = params;

  if (!Number.isFinite(period) || !Number.isInteger(period) || period < 1) {
    throw new Error(`EMA period must be a positive integer, received: ${period}`);
  }

  const k = 2 / (period + 1);

  if (bars.length === 0 || bars.length < period) {
    return {
      indicator: 'EMA',
      params,
      inputLength: bars.length,
      smoothingFactor: k,
      values: [],
    };
  }

  const values: IndicatorDataPoint[] = [];

  // Seed: SMA of first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += bars[i].close;
  }
  let ema = sum / period;

  values.push({
    timestamp: bars[period - 1].timestamp,
    value: ema,
  });

  // Exponential smoothing for remaining bars
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    values.push({
      timestamp: bars[i].timestamp,
      value: ema,
    });
  }

  return {
    indicator: 'EMA',
    params,
    inputLength: bars.length,
    smoothingFactor: k,
    values,
  };
}

/**
 * Compute EMA directly from an array of numeric values (used internally by MACD etc.).
 *
 * Returns the EMA values array (no timestamps). The first value is the SMA seed.
 * Returns an empty array if data.length < period.
 */
export function emaFromValues(data: number[], period: number): number[] {
  if (data.length < period || period < 1) return [];

  const k = 2 / (period + 1);
  const result: number[] = [];

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  let ema = sum / period;
  result.push(ema);

  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }

  return result;
}
