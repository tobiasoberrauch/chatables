/**
 * Indicators Module — Unified Entry Point
 *
 * Re-exports every indicator and provides a `compute()` dispatcher that
 * routes by indicator name to the correct implementation.
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';

// Re-export indicator types and functions
export { computeSMA, type SMAParams, type SMAResult, type IndicatorDataPoint } from './sma';
export { computeEMA, emaFromValues, type EMAParams, type EMAResult } from './ema';
export { computeRSI, type RSIParams, type RSIResult } from './rsi';
export { computeMACD, type MACDParams, type MACDResult, type MACDDataPoint } from './macd';
export { computeVWAP, type VWAPParams, type VWAPResult, type VWAPDataPoint } from './vwap';

import { computeSMA, type SMAResult } from './sma';
import { computeEMA, type EMAResult } from './ema';
import { computeRSI, type RSIResult } from './rsi';
import { computeMACD, type MACDResult } from './macd';
import { computeVWAP, type VWAPResult } from './vwap';

// --------------------------------------------------------------------------
// Unified compute() dispatcher
// --------------------------------------------------------------------------

/** All supported indicator names. */
export type IndicatorName = 'SMA' | 'EMA' | 'RSI' | 'MACD' | 'VWAP';

/** Parameter union — caller provides the params matching the chosen indicator. */
export type IndicatorParams =
  | { name: 'SMA'; period: number }
  | { name: 'EMA'; period: number }
  | { name: 'RSI'; period?: number }
  | { name: 'MACD'; fastPeriod?: number; slowPeriod?: number; signalPeriod?: number }
  | { name: 'VWAP'; includeBands?: boolean };

/** Result union. */
export type IndicatorResult = SMAResult | EMAResult | RSIResult | MACDResult | VWAPResult;

/**
 * Compute a technical indicator by name.
 *
 * This is the primary entry point for external callers who want to
 * dynamically select an indicator at runtime (e.g., from a user's
 * dashboard configuration or API request).
 *
 * @example
 * ```ts
 * const result = compute(bars, { name: 'SMA', period: 20 });
 * const result = compute(bars, { name: 'MACD', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
 * ```
 *
 * @param bars  - Chronologically sorted OHLCV bars.
 * @param params - Indicator selection and configuration.
 * @returns The computed indicator result.
 * @throws {Error} If the indicator name is unknown.
 */
export function compute(bars: OHLCVBar[], params: IndicatorParams): IndicatorResult {
  switch (params.name) {
    case 'SMA':
      return computeSMA(bars, { period: params.period });

    case 'EMA':
      return computeEMA(bars, { period: params.period });

    case 'RSI':
      return computeRSI(bars, { period: params.period ?? 14 });

    case 'MACD':
      return computeMACD(bars, {
        fastPeriod: params.fastPeriod,
        slowPeriod: params.slowPeriod,
        signalPeriod: params.signalPeriod,
      });

    case 'VWAP':
      return computeVWAP(bars, { includeBands: params.includeBands });

    default: {
      const exhaustive: never = params;
      throw new Error(`Unknown indicator: ${(exhaustive as IndicatorParams).name}`);
    }
  }
}
