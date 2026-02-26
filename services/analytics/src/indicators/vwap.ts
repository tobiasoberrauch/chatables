/**
 * Volume Weighted Average Price (VWAP) Indicator
 *
 * VWAP is an intraday benchmark calculated as:
 *
 *   VWAP_t = cumulative(typical_price * volume) / cumulative(volume)
 *
 * where typical_price = (high + low + close) / 3
 *
 * VWAP resets each trading session. This implementation supports:
 *   - Automatic session detection based on date boundaries in bar timestamps.
 *   - Manual session boundaries via an optional `sessionBreak` predicate.
 *   - Standard deviation bands (optional).
 *
 * Bars with zero volume are included in the output but do not affect the
 * cumulative totals (VWAP carries forward from the last valid value).
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';
import type { IndicatorDataPoint } from './sma';

export interface VWAPParams {
  /**
   * Optional predicate to determine session boundaries.
   * When it returns true for a bar, the VWAP resets (new session starts).
   * If not provided, session resets at each new calendar date (UTC).
   */
  sessionBreak?: (current: OHLCVBar, previous: OHLCVBar) => boolean;
  /**
   * Whether to include standard deviation bands.
   * When true, upper and lower bands at +/- 1, 2, 3 standard deviations
   * are included in the output.
   */
  includeBands?: boolean;
}

export interface VWAPDataPoint {
  timestamp: string;
  vwap: number;
  /** Upper band values at 1, 2, 3 standard deviations (if requested). */
  upperBands?: [number, number, number];
  /** Lower band values at 1, 2, 3 standard deviations (if requested). */
  lowerBands?: [number, number, number];
}

export interface VWAPResult {
  indicator: 'VWAP';
  params: { includeBands: boolean };
  inputLength: number;
  values: VWAPDataPoint[];
}

/**
 * Default session break: detects when the UTC date changes between bars.
 */
function defaultSessionBreak(current: OHLCVBar, previous: OHLCVBar): boolean {
  const currDate = current.timestamp.slice(0, 10); // YYYY-MM-DD
  const prevDate = previous.timestamp.slice(0, 10);
  return currDate !== prevDate;
}

/**
 * Compute VWAP over an array of OHLCV bars.
 *
 * Bars must be sorted chronologically (oldest first).
 * VWAP resets at each session boundary.
 */
export function computeVWAP(bars: OHLCVBar[], params: VWAPParams = {}): VWAPResult {
  const sessionBreak = params.sessionBreak ?? defaultSessionBreak;
  const includeBands = params.includeBands ?? false;

  if (bars.length === 0) {
    return {
      indicator: 'VWAP',
      params: { includeBands },
      inputLength: 0,
      values: [],
    };
  }

  const values: VWAPDataPoint[] = [];

  // Session-level accumulators
  let cumulativePV = 0;       // cumulative(price * volume)
  let cumulativeVol = 0;      // cumulative(volume)
  let cumulativePV2 = 0;      // cumulative(price^2 * volume) for std dev bands
  let barCountInSession = 0;  // number of bars processed in current session

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Detect session reset
    if (i > 0 && sessionBreak(bar, bars[i - 1])) {
      cumulativePV = 0;
      cumulativeVol = 0;
      cumulativePV2 = 0;
      barCountInSession = 0;
    }

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;

    if (bar.volume > 0) {
      cumulativePV += typicalPrice * bar.volume;
      cumulativeVol += bar.volume;
      cumulativePV2 += typicalPrice * typicalPrice * bar.volume;
    }

    barCountInSession++;

    // VWAP is undefined until we have at least some volume
    if (cumulativeVol === 0) {
      // No volume yet in this session -- emit typical price as VWAP placeholder
      const point: VWAPDataPoint = {
        timestamp: bar.timestamp,
        vwap: typicalPrice,
      };
      if (includeBands) {
        point.upperBands = [typicalPrice, typicalPrice, typicalPrice];
        point.lowerBands = [typicalPrice, typicalPrice, typicalPrice];
      }
      values.push(point);
      continue;
    }

    const vwap = cumulativePV / cumulativeVol;

    const point: VWAPDataPoint = {
      timestamp: bar.timestamp,
      vwap,
    };

    if (includeBands) {
      // Standard deviation of typical price around VWAP, weighted by volume.
      // Variance = cumulative(volume * (tp - vwap)^2) / cumulative(volume)
      //          = cumulative(tp^2 * vol) / cumVol - vwap^2
      const variance = Math.max(0, cumulativePV2 / cumulativeVol - vwap * vwap);
      const stdDev = Math.sqrt(variance);

      point.upperBands = [
        vwap + stdDev,
        vwap + 2 * stdDev,
        vwap + 3 * stdDev,
      ];
      point.lowerBands = [
        vwap - stdDev,
        vwap - 2 * stdDev,
        vwap - 3 * stdDev,
      ];
    }

    values.push(point);
  }

  return {
    indicator: 'VWAP',
    params: { includeBands },
    inputLength: bars.length,
    values,
  };
}
