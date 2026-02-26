/**
 * Portfolio Performance Calculations
 *
 * Provides production-grade portfolio analytics:
 *   - Total return (time-weighted)
 *   - Annualized return (CAGR)
 *   - Annualized volatility (standard deviation of returns)
 *   - Sharpe ratio
 *   - Sortino ratio (downside deviation only)
 *   - Maximum drawdown (peak-to-trough)
 *   - Alpha and Beta vs. a benchmark (CAPM)
 *
 * All calculations use daily returns by default (252 trading days/year).
 * Supports configurable annualization factors for different frequencies.
 *
 * Financial formulas follow CFA Institute / GIPS standards where applicable.
 */

import type { OHLCVBar } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single holding in the portfolio at a point in time. */
export interface PortfolioHolding {
  instrumentId: string;
  /** Ticker or label for display. */
  label: string;
  /** Number of shares/units held. */
  quantity: number;
  /** Average cost basis per share. */
  costBasis: number;
}

/** Price history keyed by instrumentId. */
export interface PriceHistory {
  [instrumentId: string]: OHLCVBar[];
}

/** Complete portfolio performance report. */
export interface PerformanceReport {
  /** Total return as a decimal (e.g., 0.15 = 15%). */
  totalReturn: number;
  /** Compound annual growth rate as a decimal. */
  annualizedReturn: number;
  /** Annualized standard deviation of returns. */
  volatility: number;
  /** Sharpe ratio: (annualized return - risk-free rate) / volatility. */
  sharpeRatio: number;
  /** Sortino ratio: (annualized return - risk-free rate) / downside deviation. */
  sortinoRatio: number;
  /** Maximum drawdown as a decimal (always positive, e.g., 0.25 = 25% drawdown). */
  maxDrawdown: number;
  /** Maximum drawdown details. */
  maxDrawdownDetails: DrawdownDetails;
  /** CAPM alpha (annualized excess return not explained by beta). */
  alpha: number | null;
  /** CAPM beta (sensitivity to benchmark). */
  beta: number | null;
  /** Per-holding performance breakdown. */
  holdings: HoldingPerformance[];
  /** Number of trading days in the analysis period. */
  tradingDays: number;
  /** Calendar days in the analysis period. */
  calendarDays: number;
  /** Annualization factor used (trading days per year). */
  annualizationFactor: number;
}

export interface DrawdownDetails {
  /** Maximum drawdown magnitude (positive decimal). */
  magnitude: number;
  /** Timestamp of the peak before the drawdown. */
  peakTimestamp: string;
  /** Timestamp of the trough. */
  troughTimestamp: string;
  /** Timestamp of recovery (back to peak level), or null if not recovered. */
  recoveryTimestamp: string | null;
}

export interface HoldingPerformance {
  instrumentId: string;
  label: string;
  quantity: number;
  costBasis: number;
  /** Current (last available) price. */
  currentPrice: number;
  /** Total return for this holding. */
  totalReturn: number;
  /** Profit/loss in absolute terms. */
  pnl: number;
  /** Weight in the portfolio by current market value. */
  weight: number;
}

export interface PerformanceParams {
  /** Annual risk-free rate as a decimal (default 0.05 = 5%). */
  riskFreeRate?: number;
  /** Trading days per year for annualization (default 252). */
  annualizationFactor?: number;
  /** Benchmark price bars for alpha/beta calculation. Optional. */
  benchmarkBars?: OHLCVBar[];
  /**
   * Price field to use from OHLCV bars.
   * Default: 'close'.
   */
  priceField?: 'open' | 'high' | 'low' | 'close';
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

/**
 * Compute a comprehensive performance report for a portfolio.
 *
 * @param holdings - Current portfolio holdings.
 * @param priceHistory - Price bars for each holding, keyed by instrumentId.
 *   Bars must be sorted chronologically (oldest first).
 * @param params - Configuration parameters.
 * @returns Complete performance report.
 * @throws {Error} If no price data is available for any holding.
 */
export function computePerformance(
  holdings: PortfolioHolding[],
  priceHistory: PriceHistory,
  params: PerformanceParams = {},
): PerformanceReport {
  const {
    riskFreeRate = 0.05,
    annualizationFactor = 252,
    benchmarkBars,
    priceField = 'close',
  } = params;

  if (holdings.length === 0) {
    throw new Error('Portfolio must contain at least one holding');
  }

  // Validate that we have price data for every holding
  for (const h of holdings) {
    const bars = priceHistory[h.instrumentId];
    if (!bars || bars.length === 0) {
      throw new Error(`No price data for instrument ${h.instrumentId} (${h.label})`);
    }
  }

  // Step 1: Build daily portfolio value time series
  const { portfolioValues, timestamps } = buildPortfolioValueSeries(
    holdings, priceHistory, priceField,
  );

  if (portfolioValues.length < 2) {
    throw new Error('Need at least 2 data points to compute performance');
  }

  // Step 2: Compute daily portfolio returns
  const dailyReturns = computeReturns(portfolioValues);

  // Step 3: Core metrics
  const totalReturn = (portfolioValues[portfolioValues.length - 1] / portfolioValues[0]) - 1;

  // Calendar days between first and last timestamp
  const firstDate = new Date(timestamps[0]);
  const lastDate = new Date(timestamps[timestamps.length - 1]);
  const calendarDays = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));
  const tradingDays = portfolioValues.length;

  // Annualized return (CAGR)
  // CAGR = (V_final / V_initial) ^ (annualizationFactor / tradingDays) - 1
  const yearsTrading = tradingDays / annualizationFactor;
  const annualizedReturn = yearsTrading > 0
    ? Math.pow(1 + totalReturn, 1 / yearsTrading) - 1
    : 0;

  // Volatility (annualized standard deviation of daily returns)
  const volatility = standardDeviation(dailyReturns) * Math.sqrt(annualizationFactor);

  // Sharpe Ratio
  const dailyRiskFree = riskFreeRate / annualizationFactor;
  const excessReturns = dailyReturns.map((r) => r - dailyRiskFree);
  const sharpeRatio = volatility === 0
    ? 0
    : (annualizedReturn - riskFreeRate) / volatility;

  // Sortino Ratio — uses downside deviation (only negative excess returns)
  const downsideDeviation = computeDownsideDeviation(excessReturns, annualizationFactor);
  const sortinoRatio = downsideDeviation === 0
    ? 0
    : (annualizedReturn - riskFreeRate) / downsideDeviation;

  // Maximum Drawdown
  const maxDrawdownDetails = computeMaxDrawdown(portfolioValues, timestamps);

  // Alpha & Beta (CAPM)
  let alpha: number | null = null;
  let beta: number | null = null;

  if (benchmarkBars && benchmarkBars.length >= 2) {
    const benchmarkResult = computeAlphaBeta(
      dailyReturns,
      timestamps.slice(1), // returns have one less element than values
      benchmarkBars,
      priceField,
      riskFreeRate,
      annualizationFactor,
    );
    alpha = benchmarkResult.alpha;
    beta = benchmarkResult.beta;
  }

  // Step 4: Per-holding breakdown
  const holdingPerfs = computeHoldingPerformance(holdings, priceHistory, priceField);

  return {
    totalReturn: roundTo(totalReturn, 6),
    annualizedReturn: roundTo(annualizedReturn, 6),
    volatility: roundTo(volatility, 6),
    sharpeRatio: roundTo(sharpeRatio, 4),
    sortinoRatio: roundTo(sortinoRatio, 4),
    maxDrawdown: roundTo(maxDrawdownDetails.magnitude, 6),
    maxDrawdownDetails,
    alpha: alpha !== null ? roundTo(alpha, 6) : null,
    beta: beta !== null ? roundTo(beta, 4) : null,
    holdings: holdingPerfs,
    tradingDays,
    calendarDays: Math.round(calendarDays),
    annualizationFactor,
  };
}

// ---------------------------------------------------------------------------
// Portfolio value time series construction
// ---------------------------------------------------------------------------

/**
 * Build a daily portfolio value time series by summing
 * (quantity * price) across all holdings for each timestamp.
 *
 * Only timestamps where ALL holdings have data are included (inner join).
 */
function buildPortfolioValueSeries(
  holdings: PortfolioHolding[],
  priceHistory: PriceHistory,
  priceField: 'open' | 'high' | 'low' | 'close',
): { portfolioValues: number[]; timestamps: string[] } {
  // Build price maps for each holding: timestamp -> price
  const priceMaps: Map<string, number>[] = holdings.map((h) => {
    const map = new Map<string, number>();
    for (const bar of priceHistory[h.instrumentId]) {
      map.set(bar.timestamp, bar[priceField]);
    }
    return map;
  });

  // Collect all timestamps where every holding has data
  // Start with the timestamps of the first holding, then intersect
  let commonTimestamps: Set<string> = new Set(priceMaps[0].keys());
  for (let i = 1; i < priceMaps.length; i++) {
    const next = new Set<string>();
    for (const ts of commonTimestamps) {
      if (priceMaps[i].has(ts)) {
        next.add(ts);
      }
    }
    commonTimestamps = next;
  }

  // Sort timestamps chronologically
  const sortedTimestamps = [...commonTimestamps].sort();

  // Compute portfolio value at each timestamp
  const portfolioValues: number[] = [];
  for (const ts of sortedTimestamps) {
    let value = 0;
    for (let i = 0; i < holdings.length; i++) {
      const price = priceMaps[i].get(ts)!;
      value += holdings[i].quantity * price;
    }
    portfolioValues.push(value);
  }

  return { portfolioValues, timestamps: sortedTimestamps };
}

// ---------------------------------------------------------------------------
// Returns computation
// ---------------------------------------------------------------------------

/** Compute simple returns from a value series. */
function computeReturns(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === 0) {
      returns.push(0);
    } else {
      returns.push((values[i] / values[i - 1]) - 1);
    }
  }
  return returns;
}

// ---------------------------------------------------------------------------
// Statistical functions
// ---------------------------------------------------------------------------

/** Population mean. */
function mean(data: number[]): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (const d of data) sum += d;
  return sum / data.length;
}

/** Sample standard deviation (Bessel's correction, n-1). */
function standardDeviation(data: number[]): number {
  if (data.length < 2) return 0;
  const avg = mean(data);
  let sumSq = 0;
  for (const d of data) {
    const diff = d - avg;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (data.length - 1));
}

/**
 * Annualized downside deviation.
 *
 * Only considers returns below zero (or below the target, which for
 * Sortino is excess return < 0, i.e., return < risk-free rate).
 *
 * downsideDev = sqrt( (1/n) * sum(min(r_i, 0)^2) ) * sqrt(annualizationFactor)
 *
 * Note: uses n (not n-1) per the original Sortino/van der Meer definition.
 */
function computeDownsideDeviation(
  excessReturns: number[],
  annualizationFactor: number,
): number {
  if (excessReturns.length === 0) return 0;

  let sumSq = 0;
  for (const r of excessReturns) {
    if (r < 0) {
      sumSq += r * r;
    }
  }

  const dailyDownside = Math.sqrt(sumSq / excessReturns.length);
  return dailyDownside * Math.sqrt(annualizationFactor);
}

// ---------------------------------------------------------------------------
// Maximum Drawdown
// ---------------------------------------------------------------------------

/**
 * Compute maximum drawdown from a value series.
 *
 * Drawdown_t = (peak_t - value_t) / peak_t
 *
 * where peak_t = max(value_0, ..., value_t)
 *
 * Returns the largest drawdown magnitude and its peak/trough/recovery timestamps.
 */
function computeMaxDrawdown(
  values: number[],
  timestamps: string[],
): DrawdownDetails {
  let peak = values[0];
  let peakIdx = 0;
  let maxDD = 0;
  let maxDDPeakIdx = 0;
  let maxDDTroughIdx = 0;

  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
      peakIdx = i;
    }

    const drawdown = peak > 0 ? (peak - values[i]) / peak : 0;
    if (drawdown > maxDD) {
      maxDD = drawdown;
      maxDDPeakIdx = peakIdx;
      maxDDTroughIdx = i;
    }
  }

  // Find recovery: first timestamp after trough where value >= peak at maxDDPeakIdx
  let recoveryTimestamp: string | null = null;
  const peakValue = values[maxDDPeakIdx];
  for (let i = maxDDTroughIdx + 1; i < values.length; i++) {
    if (values[i] >= peakValue) {
      recoveryTimestamp = timestamps[i];
      break;
    }
  }

  return {
    magnitude: maxDD,
    peakTimestamp: timestamps[maxDDPeakIdx],
    troughTimestamp: timestamps[maxDDTroughIdx],
    recoveryTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Alpha & Beta (CAPM regression)
// ---------------------------------------------------------------------------

/**
 * Compute CAPM alpha and beta using ordinary least squares regression.
 *
 * Model: R_p - R_f = alpha + beta * (R_b - R_f) + epsilon
 *
 * where:
 *   R_p = portfolio return
 *   R_b = benchmark return
 *   R_f = risk-free rate (daily)
 *
 * Beta  = cov(R_p - R_f, R_b - R_f) / var(R_b - R_f)
 * Alpha = mean(R_p - R_f) - beta * mean(R_b - R_f)
 *
 * Alpha is annualized: alpha_annual = alpha_daily * annualizationFactor.
 */
function computeAlphaBeta(
  portfolioReturns: number[],
  portfolioTimestamps: string[],
  benchmarkBars: OHLCVBar[],
  priceField: 'open' | 'high' | 'low' | 'close',
  riskFreeRate: number,
  annualizationFactor: number,
): { alpha: number; beta: number } {
  // Build benchmark returns map
  const benchmarkPriceMap = new Map<string, number>();
  for (const bar of benchmarkBars) {
    benchmarkPriceMap.set(bar.timestamp, bar[priceField]);
  }

  // Build benchmark returns keyed by timestamp
  const benchmarkReturnMap = new Map<string, number>();
  const sortedBenchmarkBars = [...benchmarkBars].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  for (let i = 1; i < sortedBenchmarkBars.length; i++) {
    const prev = sortedBenchmarkBars[i - 1][priceField];
    const curr = sortedBenchmarkBars[i][priceField];
    if (prev > 0) {
      benchmarkReturnMap.set(sortedBenchmarkBars[i].timestamp, (curr / prev) - 1);
    }
  }

  // Align portfolio and benchmark returns by timestamp
  const dailyRF = riskFreeRate / annualizationFactor;
  const alignedP: number[] = [];
  const alignedB: number[] = [];

  for (let i = 0; i < portfolioReturns.length; i++) {
    const ts = portfolioTimestamps[i];
    const benchRet = benchmarkReturnMap.get(ts);
    if (benchRet !== undefined) {
      alignedP.push(portfolioReturns[i] - dailyRF);
      alignedB.push(benchRet - dailyRF);
    }
  }

  if (alignedP.length < 3) {
    return { alpha: 0, beta: 1 }; // Default to market-neutral when insufficient data
  }

  // OLS regression
  const meanP = mean(alignedP);
  const meanB = mean(alignedB);

  let covariance = 0;
  let varianceB = 0;
  for (let i = 0; i < alignedP.length; i++) {
    const dp = alignedP[i] - meanP;
    const db = alignedB[i] - meanB;
    covariance += dp * db;
    varianceB += db * db;
  }

  if (varianceB === 0) {
    return { alpha: 0, beta: 0 };
  }

  const beta = covariance / varianceB;
  // Daily alpha, then annualize
  const dailyAlpha = meanP - beta * meanB;
  const alpha = dailyAlpha * annualizationFactor;

  return { alpha, beta };
}

// ---------------------------------------------------------------------------
// Per-holding performance
// ---------------------------------------------------------------------------

function computeHoldingPerformance(
  holdings: PortfolioHolding[],
  priceHistory: PriceHistory,
  priceField: 'open' | 'high' | 'low' | 'close',
): HoldingPerformance[] {
  const results: HoldingPerformance[] = [];
  let totalCurrentValue = 0;

  // First pass: compute current values for weights
  const currentPrices: number[] = [];
  for (const h of holdings) {
    const bars = priceHistory[h.instrumentId];
    const lastPrice = bars[bars.length - 1][priceField];
    currentPrices.push(lastPrice);
    totalCurrentValue += h.quantity * lastPrice;
  }

  // Second pass: build results
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const currentPrice = currentPrices[i];
    const currentValue = h.quantity * currentPrice;
    const costValue = h.quantity * h.costBasis;
    const pnl = currentValue - costValue;
    const totalReturn = costValue === 0 ? 0 : pnl / costValue;

    results.push({
      instrumentId: h.instrumentId,
      label: h.label,
      quantity: h.quantity,
      costBasis: h.costBasis,
      currentPrice,
      totalReturn: roundTo(totalReturn, 6),
      pnl: roundTo(pnl, 2),
      weight: totalCurrentValue === 0 ? 0 : roundTo(currentValue / totalCurrentValue, 6),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
