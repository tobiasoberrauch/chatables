/**
 * Portfolio Performance Analytics
 *
 * Provides calculations for core portfolio performance metrics:
 *   - Total return
 *   - Annualized return
 *   - Sharpe ratio
 *   - Sortino ratio
 *   - Maximum drawdown
 *   - Beta (vs benchmark)
 *
 * All calculations follow industry standard formulas.
 */

export interface PortfolioPosition {
  instrumentId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryDate: string;   // ISO 8601
  exitDate: string;     // ISO 8601
}

export interface DrawdownResult {
  maxDrawdown: number;          // As a positive fraction (e.g., 0.20 = 20%)
  maxDrawdownPercent: number;   // As percentage (e.g., 20.0)
  peakIndex: number;
  troughIndex: number;
  peakValue: number;
  troughValue: number;
}

/**
 * Calculate total return for a set of positions.
 *
 * Total Return = sum((exitPrice - entryPrice) * quantity) / sum(entryPrice * quantity)
 */
export function totalReturn(positions: PortfolioPosition[]): number {
  if (positions.length === 0) return 0;

  let totalPnL = 0;
  let totalInvested = 0;

  for (const pos of positions) {
    totalPnL += (pos.exitPrice - pos.entryPrice) * pos.quantity;
    totalInvested += pos.entryPrice * pos.quantity;
  }

  if (totalInvested === 0) return 0;
  return totalPnL / totalInvested;
}

/**
 * Calculate annualized return from a total return and holding period.
 *
 * Annualized Return = (1 + totalReturn)^(365 / days) - 1
 *
 * @param totalRet - Total return as a decimal (e.g., 0.10 for 10%)
 * @param days - Number of calendar days in the holding period
 */
export function annualizedReturn(totalRet: number, days: number): number {
  if (days <= 0) return 0;
  return Math.pow(1 + totalRet, 365 / days) - 1;
}

/**
 * Calculate the Sharpe ratio from a series of periodic returns.
 *
 * Sharpe = (mean(returns) - riskFreeRate) / stddev(returns)
 *
 * The riskFreeRate should be expressed in the same period as the returns.
 * For example, if returns are daily, use daily risk-free rate.
 *
 * @param returns - Array of periodic returns (e.g., daily returns)
 * @param riskFreeRate - Risk-free rate per period (default 0)
 */
export function sharpeRatio(returns: number[], riskFreeRate: number = 0): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excessMean = mean - riskFreeRate;

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return excessMean / stdDev;
}

/**
 * Calculate the Sortino ratio from a series of periodic returns.
 *
 * Sortino = (mean(returns) - riskFreeRate) / downsideDeviation
 *
 * Downside deviation only considers returns below the target (risk-free rate).
 *
 * @param returns - Array of periodic returns
 * @param riskFreeRate - Risk-free rate per period (default 0, also used as MAR)
 */
export function sortinoRatio(returns: number[], riskFreeRate: number = 0): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excessMean = mean - riskFreeRate;

  // Downside deviation: only negative excess returns contribute
  const downsideSquares = returns
    .map((r) => Math.min(0, r - riskFreeRate))
    .map((d) => d * d);
  const downsideVariance =
    downsideSquares.reduce((a, b) => a + b, 0) / (returns.length - 1);
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return 0;
  return excessMean / downsideDev;
}

/**
 * Calculate the maximum drawdown from a price/value series.
 *
 * Max drawdown is the largest peak-to-trough decline in the series.
 *
 * @param values - Array of portfolio values or prices (chronological order)
 */
export function maxDrawdown(values: number[]): DrawdownResult {
  if (values.length < 2) {
    return {
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      peakIndex: 0,
      troughIndex: 0,
      peakValue: values[0] ?? 0,
      troughValue: values[0] ?? 0,
    };
  }

  let peak = values[0];
  let peakIdx = 0;
  let maxDD = 0;
  let resultPeakIdx = 0;
  let resultTroughIdx = 0;
  let resultPeakVal = values[0];
  let resultTroughVal = values[0];

  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
      peakIdx = i;
    }

    const drawdown = peak > 0 ? (peak - values[i]) / peak : 0;

    if (drawdown > maxDD) {
      maxDD = drawdown;
      resultPeakIdx = peakIdx;
      resultTroughIdx = i;
      resultPeakVal = peak;
      resultTroughVal = values[i];
    }
  }

  return {
    maxDrawdown: maxDD,
    maxDrawdownPercent: maxDD * 100,
    peakIndex: resultPeakIdx,
    troughIndex: resultTroughIdx,
    peakValue: resultPeakVal,
    troughValue: resultTroughVal,
  };
}

/**
 * Calculate beta of an asset against a benchmark.
 *
 * Beta = cov(assetReturns, benchmarkReturns) / var(benchmarkReturns)
 *
 * @param assetReturns - Array of asset periodic returns
 * @param benchmarkReturns - Array of benchmark periodic returns (same length)
 */
export function calculateBeta(
  assetReturns: number[],
  benchmarkReturns: number[],
): number {
  if (assetReturns.length !== benchmarkReturns.length) {
    throw new Error(
      `Asset and benchmark returns must have equal length. Got ${assetReturns.length} and ${benchmarkReturns.length}`,
    );
  }

  const n = assetReturns.length;
  if (n < 2) return 0;

  const meanAsset = assetReturns.reduce((a, b) => a + b, 0) / n;
  const meanBench = benchmarkReturns.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let benchVariance = 0;

  for (let i = 0; i < n; i++) {
    const dAsset = assetReturns[i] - meanAsset;
    const dBench = benchmarkReturns[i] - meanBench;
    covariance += dAsset * dBench;
    benchVariance += dBench * dBench;
  }

  if (benchVariance === 0) return 0;
  return covariance / benchVariance;
}
