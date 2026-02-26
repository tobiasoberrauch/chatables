import { describe, it, expect } from 'vitest';
import {
  totalReturn,
  annualizedReturn,
  sharpeRatio,
  sortinoRatio,
  maxDrawdown,
  calculateBeta,
} from '../src/portfolio/portfolio';
import type { PortfolioPosition } from '../src/portfolio/portfolio';

// ============================================================================
// Total Return
// ============================================================================

describe('totalReturn', () => {
  it('calculates 10% return: buy at 100, sell at 110', () => {
    const positions: PortfolioPosition[] = [
      {
        instrumentId: 'AAPL',
        entryPrice: 100,
        exitPrice: 110,
        quantity: 1,
        entryDate: '2025-01-01',
        exitDate: '2025-04-01',
      },
    ];
    expect(totalReturn(positions)).toBeCloseTo(0.10, 10);
  });

  it('calculates negative return: buy at 100, sell at 90', () => {
    const positions: PortfolioPosition[] = [
      {
        instrumentId: 'AAPL',
        entryPrice: 100,
        exitPrice: 90,
        quantity: 1,
        entryDate: '2025-01-01',
        exitDate: '2025-04-01',
      },
    ];
    expect(totalReturn(positions)).toBeCloseTo(-0.10, 10);
  });

  it('handles multiple positions with different quantities', () => {
    const positions: PortfolioPosition[] = [
      {
        instrumentId: 'AAPL',
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        entryDate: '2025-01-01',
        exitDate: '2025-04-01',
      },
      {
        instrumentId: 'GOOG',
        entryPrice: 200,
        exitPrice: 190,
        quantity: 5,
        entryDate: '2025-01-01',
        exitDate: '2025-04-01',
      },
    ];
    // PnL = (110-100)*10 + (190-200)*5 = 100 - 50 = 50
    // Invested = 100*10 + 200*5 = 1000 + 1000 = 2000
    // Return = 50/2000 = 0.025
    expect(totalReturn(positions)).toBeCloseTo(0.025, 10);
  });

  it('returns 0 for empty positions', () => {
    expect(totalReturn([])).toBe(0);
  });

  it('returns 0 when total invested is 0', () => {
    const positions: PortfolioPosition[] = [
      {
        instrumentId: 'TEST',
        entryPrice: 0,
        exitPrice: 10,
        quantity: 1,
        entryDate: '2025-01-01',
        exitDate: '2025-04-01',
      },
    ];
    expect(totalReturn(positions)).toBe(0);
  });
});

// ============================================================================
// Annualized Return
// ============================================================================

describe('annualizedReturn', () => {
  it('10% over 365 days → 10% annualized', () => {
    expect(annualizedReturn(0.10, 365)).toBeCloseTo(0.10, 10);
  });

  it('10% over 730 days → ~4.88% annualized', () => {
    // (1.10)^(365/730) - 1 = (1.10)^0.5 - 1 ≈ 0.04881
    const expected = Math.pow(1.10, 0.5) - 1;
    expect(annualizedReturn(0.10, 730)).toBeCloseTo(expected, 6);
  });

  it('10% over 182.5 days → ~21% annualized', () => {
    // (1.10)^(365/182.5) - 1 = (1.10)^2 - 1 = 0.21
    const expected = Math.pow(1.10, 2) - 1;
    expect(annualizedReturn(0.10, 182.5)).toBeCloseTo(expected, 6);
  });

  it('returns 0 for 0 days', () => {
    expect(annualizedReturn(0.10, 0)).toBe(0);
  });

  it('returns 0 for negative days', () => {
    expect(annualizedReturn(0.10, -10)).toBe(0);
  });

  it('handles negative returns', () => {
    // -10% over 365 days → -10% annualized
    expect(annualizedReturn(-0.10, 365)).toBeCloseTo(-0.10, 10);
  });
});

// ============================================================================
// Sharpe Ratio
// ============================================================================

describe('sharpeRatio', () => {
  it('computes Sharpe with known returns', () => {
    const returns = [0.01, 0.02, -0.01, 0.03, 0.015];
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    const expectedSharpe = mean / stdDev; // riskFreeRate = 0

    expect(sharpeRatio(returns)).toBeCloseTo(expectedSharpe, 10);
  });

  it('subtracts risk-free rate from mean', () => {
    const returns = [0.05, 0.05, 0.05, 0.05, 0.05];
    // All same returns → stddev = 0 → Sharpe = 0
    expect(sharpeRatio(returns, 0.01)).toBe(0);
  });

  it('returns 0 when standard deviation is 0', () => {
    const returns = [0.02, 0.02, 0.02, 0.02];
    expect(sharpeRatio(returns)).toBe(0);
  });

  it('returns 0 with fewer than 2 returns', () => {
    expect(sharpeRatio([])).toBe(0);
    expect(sharpeRatio([0.01])).toBe(0);
  });

  it('returns positive Sharpe for consistently positive returns', () => {
    const returns = [0.01, 0.02, 0.015, 0.025, 0.01];
    expect(sharpeRatio(returns)).toBeGreaterThan(0);
  });

  it('returns negative Sharpe for consistently negative returns', () => {
    const returns = [-0.01, -0.02, -0.015, -0.025, -0.01];
    expect(sharpeRatio(returns)).toBeLessThan(0);
  });
});

// ============================================================================
// Max Drawdown
// ============================================================================

describe('maxDrawdown', () => {
  it('calculates 25% drawdown from 120 to 90 in [100,120,90,130]', () => {
    const result = maxDrawdown([100, 120, 90, 130]);

    // Peak = 120, Trough = 90, Drawdown = (120-90)/120 = 0.25
    expect(result.maxDrawdown).toBeCloseTo(0.25, 10);
    expect(result.maxDrawdownPercent).toBeCloseTo(25.0, 10);
    expect(result.peakValue).toBe(120);
    expect(result.troughValue).toBe(90);
    expect(result.peakIndex).toBe(1);
    expect(result.troughIndex).toBe(2);
  });

  it('returns 0 drawdown for monotonically increasing series', () => {
    const result = maxDrawdown([100, 110, 120, 130, 140]);
    expect(result.maxDrawdown).toBe(0);
    expect(result.maxDrawdownPercent).toBe(0);
  });

  it('calculates drawdown for monotonically decreasing series', () => {
    const result = maxDrawdown([100, 90, 80, 70, 60]);
    // Peak = 100, Trough = 60, Drawdown = 40/100 = 0.40
    expect(result.maxDrawdown).toBeCloseTo(0.40, 10);
    expect(result.peakIndex).toBe(0);
    expect(result.troughIndex).toBe(4);
  });

  it('finds the worst drawdown among multiple drawdowns', () => {
    const result = maxDrawdown([100, 90, 120, 80, 150]);
    // Drawdown 1: 100 → 90 = 10%
    // Drawdown 2: 120 → 80 = 33.33%
    // Max drawdown is 33.33%
    expect(result.maxDrawdown).toBeCloseTo(1 / 3, 6);
    expect(result.peakValue).toBe(120);
    expect(result.troughValue).toBe(80);
  });

  it('handles single value', () => {
    const result = maxDrawdown([100]);
    expect(result.maxDrawdown).toBe(0);
  });

  it('handles empty array', () => {
    const result = maxDrawdown([]);
    expect(result.maxDrawdown).toBe(0);
  });
});

// ============================================================================
// Sortino Ratio
// ============================================================================

describe('sortinoRatio', () => {
  it('only negative returns count for downside deviation denominator', () => {
    // Mix of positive and negative returns
    const returns = [0.05, -0.02, 0.03, -0.01, 0.04];
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    // Downside: only r < 0 contributes
    const downsideSquares = returns.map((r) => Math.min(0, r)).map((d) => d * d);
    const downsideVariance =
      downsideSquares.reduce((a, b) => a + b, 0) / (returns.length - 1);
    const downsideDev = Math.sqrt(downsideVariance);

    const expectedSortino = mean / downsideDev;
    expect(sortinoRatio(returns)).toBeCloseTo(expectedSortino, 10);
  });

  it('returns 0 when all returns are positive (no downside deviation)', () => {
    const returns = [0.01, 0.02, 0.03, 0.04, 0.05];
    // No negative returns → downside deviation = 0 → Sortino = 0
    expect(sortinoRatio(returns)).toBe(0);
  });

  it('Sortino is higher than Sharpe when most returns are positive', () => {
    const returns = [0.05, 0.03, -0.01, 0.04, 0.02, -0.005, 0.06];
    const sharpe = sharpeRatio(returns);
    const sortino = sortinoRatio(returns);
    // Sortino should generally be higher since denominator is smaller
    // (only downside volatility, not total volatility)
    expect(sortino).toBeGreaterThan(sharpe);
  });

  it('returns 0 with fewer than 2 returns', () => {
    expect(sortinoRatio([])).toBe(0);
    expect(sortinoRatio([0.01])).toBe(0);
  });
});

// ============================================================================
// Beta
// ============================================================================

describe('calculateBeta', () => {
  it('asset perfectly correlated with benchmark → beta ~1.0', () => {
    // Identical returns → beta = cov(X,X)/var(X) = 1.0
    const returns = [0.01, 0.02, -0.01, 0.03, -0.02, 0.015];
    expect(calculateBeta(returns, returns)).toBeCloseTo(1.0, 10);
  });

  it('asset moves 2x the benchmark → beta ~2.0', () => {
    const benchmarkReturns = [0.01, 0.02, -0.01, 0.03, -0.02];
    const assetReturns = benchmarkReturns.map((r) => r * 2);
    expect(calculateBeta(assetReturns, benchmarkReturns)).toBeCloseTo(2.0, 10);
  });

  it('asset inversely correlated → beta ~-1.0', () => {
    const benchmarkReturns = [0.01, 0.02, -0.01, 0.03, -0.02];
    const assetReturns = benchmarkReturns.map((r) => -r);
    expect(calculateBeta(assetReturns, benchmarkReturns)).toBeCloseTo(-1.0, 10);
  });

  it('throws when arrays have different lengths', () => {
    expect(() => calculateBeta([0.01, 0.02], [0.01])).toThrow();
  });

  it('returns 0 with fewer than 2 data points', () => {
    expect(calculateBeta([], [])).toBe(0);
    expect(calculateBeta([0.01], [0.02])).toBe(0);
  });

  it('returns 0 when benchmark has zero variance', () => {
    // Constant benchmark returns → zero variance → beta = 0
    const asset = [0.01, 0.02, -0.01, 0.03];
    const bench = [0.01, 0.01, 0.01, 0.01];
    expect(calculateBeta(asset, bench)).toBe(0);
  });

  it('handles zero mean returns', () => {
    const bench = [0.01, -0.01, 0.02, -0.02];
    const asset = [0.02, -0.02, 0.04, -0.04];
    expect(calculateBeta(asset, bench)).toBeCloseTo(2.0, 10);
  });
});
