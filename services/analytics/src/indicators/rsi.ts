/**
 * Relative Strength Index (RSI) Indicator
 *
 * Developed by J. Welles Wilder Jr. (1978).
 *
 * RSI = 100 - 100 / (1 + RS)
 * RS  = Average Gain / Average Loss
 *
 * The standard approach (Wilder's smoothing):
 *   1. First average gain/loss = arithmetic mean of first `period` changes.
 *   2. Subsequent values use exponential smoothing:
 *        avgGain_t = (avgGain_{t-1} * (period - 1) + currentGain) / period
 *        avgLoss_t = (avgLoss_{t-1} * (period - 1) + currentLoss) / period
 *
 * This matches the Wilder smoothing method used by most platforms.
 *
 * Output range: [0, 100].
 *   - RSI = 100 when average loss is zero (only gains in window).
 *   - RSI = 0 when average gain is zero (only losses in window).
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';
import type { IndicatorDataPoint } from './sma';

export interface RSIParams {
  /** Lookback period (default 14). Must be >= 1. */
  period: number;
}

export interface RSIResult {
  indicator: 'RSI';
  params: RSIParams;
  inputLength: number;
  /**
   * Computed RSI values in range [0, 100].
   * The first RSI appears at bar index `period` (needs `period` price changes,
   * which requires `period + 1` bars). Length = max(0, inputLength - period).
   */
  values: IndicatorDataPoint[];
}

/**
 * Compute the Relative Strength Index over an array of OHLCV bars.
 *
 * Bars must be sorted chronologically (oldest first).
 *
 * @param bars - OHLCV bar array.
 * @param params - RSI parameters. Defaults to period = 14.
 * @throws {Error} If period < 1 or is not a finite integer.
 */
export function computeRSI(
  bars: OHLCVBar[],
  params: RSIParams = { period: 14 },
): RSIResult {
  const { period } = params;

  if (!Number.isFinite(period) || !Number.isInteger(period) || period < 1) {
    throw new Error(`RSI period must be a positive integer, received: ${period}`);
  }

  // We need at least (period + 1) bars to compute the first RSI
  // because we need `period` price changes.
  if (bars.length < period + 1) {
    return {
      indicator: 'RSI',
      params,
      inputLength: bars.length,
      values: [],
    };
  }

  const values: IndicatorDataPoint[] = [];

  // Step 1: compute price changes
  const changes: number[] = new Array(bars.length - 1);
  for (let i = 1; i < bars.length; i++) {
    changes[i - 1] = bars[i].close - bars[i - 1].close;
  }

  // Step 2: first average gain and loss (SMA of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change > 0) {
      avgGain += change;
    } else {
      avgLoss += Math.abs(change);
    }
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  values.push({
    timestamp: bars[period].timestamp,
    value: rsiFromAvg(avgGain, avgLoss),
  });

  // Step 3: Wilder's smoothing for subsequent values
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    values.push({
      timestamp: bars[i + 1].timestamp,
      value: rsiFromAvg(avgGain, avgLoss),
    });
  }

  return {
    indicator: 'RSI',
    params,
    inputLength: bars.length,
    values,
  };
}

/** Derive RSI from average gain and average loss, handling division-by-zero. */
function rsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100; // No movement => 50; only gains => 100
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
