/**
 * Moving Average Convergence Divergence (MACD) Indicator
 *
 * Developed by Gerald Appel (late 1970s).
 *
 * Components:
 *   MACD Line    = EMA(fast) - EMA(slow)
 *   Signal Line  = EMA(MACD Line, signalPeriod)
 *   Histogram    = MACD Line - Signal Line
 *
 * Standard parameters: fast=12, slow=26, signal=9.
 *
 * The slow EMA requires `slowPeriod` bars to produce its first value
 * (SMA seed at index slowPeriod-1). The MACD line therefore starts at
 * index (slowPeriod - 1). The signal line requires an additional
 * (signalPeriod - 1) MACD values, so the full output (with histogram)
 * starts at index (slowPeriod + signalPeriod - 2).
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';
import type { IndicatorDataPoint } from './sma';
import { emaFromValues } from './ema';

export interface MACDParams {
  /** Fast EMA period (default 12). */
  fastPeriod: number;
  /** Slow EMA period (default 26). */
  slowPeriod: number;
  /** Signal line EMA period (default 9). */
  signalPeriod: number;
}

export interface MACDDataPoint {
  timestamp: string;
  macd: number;
  signal: number;
  histogram: number;
}

export interface MACDResult {
  indicator: 'MACD';
  params: MACDParams;
  inputLength: number;
  /**
   * MACD line values (EMA_fast - EMA_slow).
   * Starts at bar index (slowPeriod - 1).
   */
  macdLine: IndicatorDataPoint[];
  /**
   * Full MACD output: MACD line, signal line, and histogram.
   * Starts at bar index (slowPeriod + signalPeriod - 2).
   */
  values: MACDDataPoint[];
}

const DEFAULT_MACD_PARAMS: MACDParams = {
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
};

/**
 * Compute MACD with signal line and histogram.
 *
 * Bars must be sorted chronologically (oldest first).
 *
 * @throws {Error} If any period is < 1 or fastPeriod >= slowPeriod.
 */
export function computeMACD(
  bars: OHLCVBar[],
  params: Partial<MACDParams> = {},
): MACDResult {
  const p: MACDParams = { ...DEFAULT_MACD_PARAMS, ...params };
  const { fastPeriod, slowPeriod, signalPeriod } = p;

  // Validate
  for (const [name, val] of Object.entries({ fastPeriod, slowPeriod, signalPeriod })) {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 1) {
      throw new Error(`MACD ${name} must be a positive integer, received: ${val}`);
    }
  }
  if (fastPeriod >= slowPeriod) {
    throw new Error(
      `MACD fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`,
    );
  }

  const closes = bars.map((b) => b.close);

  // Compute fast and slow EMA from close prices
  const fastEma = emaFromValues(closes, fastPeriod);
  const slowEma = emaFromValues(closes, slowPeriod);

  if (slowEma.length === 0) {
    return {
      indicator: 'MACD',
      params: p,
      inputLength: bars.length,
      macdLine: [],
      values: [],
    };
  }

  // Align: fastEma starts at index (fastPeriod - 1), slowEma at (slowPeriod - 1).
  // The MACD line is defined where both exist, starting at (slowPeriod - 1).
  // fastEma[i] corresponds to bar at index (fastPeriod - 1 + i).
  // slowEma[j] corresponds to bar at index (slowPeriod - 1 + j).
  // At bar index b = (slowPeriod - 1 + j):
  //   fastEma index = b - (fastPeriod - 1) = slowPeriod - fastPeriod + j
  const fastOffset = slowPeriod - fastPeriod;

  const macdRaw: number[] = [];
  const macdLine: IndicatorDataPoint[] = [];

  for (let j = 0; j < slowEma.length; j++) {
    const fastIdx = fastOffset + j;
    const macdVal = fastEma[fastIdx] - slowEma[j];
    macdRaw.push(macdVal);
    const barIdx = slowPeriod - 1 + j;
    macdLine.push({
      timestamp: bars[barIdx].timestamp,
      value: macdVal,
    });
  }

  // Signal line = EMA of MACD raw values
  const signalEma = emaFromValues(macdRaw, signalPeriod);

  if (signalEma.length === 0) {
    return {
      indicator: 'MACD',
      params: p,
      inputLength: bars.length,
      macdLine,
      values: [],
    };
  }

  // signalEma[i] corresponds to macdRaw index (signalPeriod - 1 + i)
  const values: MACDDataPoint[] = [];
  for (let i = 0; i < signalEma.length; i++) {
    const macdIdx = signalPeriod - 1 + i;
    const barIdx = slowPeriod - 1 + macdIdx;
    const macdVal = macdRaw[macdIdx];
    const signalVal = signalEma[i];
    values.push({
      timestamp: bars[barIdx].timestamp,
      macd: macdVal,
      signal: signalVal,
      histogram: macdVal - signalVal,
    });
  }

  return {
    indicator: 'MACD',
    params: p,
    inputLength: bars.length,
    macdLine,
    values,
  };
}
