import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { validate, validatedQuery } from '../middleware/validation';
import { authenticate, requireRole } from '../middleware/auth';
import { UserRole, BarSize, type ApiError } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Technical indicator computation helpers
// ---------------------------------------------------------------------------

interface OHLCV {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function computeSMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += data[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

function computeEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const multiplier = 2 / (period + 1);

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      // Seed with SMA
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[j];
      }
      result.push(sum / period);
    } else {
      const prev = result[i - 1]!;
      result.push((data[i] - prev) * multiplier + prev);
    }
  }
  return result;
}

function computeRSI(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [null]; // First element has no change

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);

    if (i < period) {
      result.push(null);
      continue;
    }

    if (i === period) {
      const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
      if (avgLoss === 0) {
        result.push(100);
      } else {
        const rs = avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      }
    } else {
      const prevRsi = result[i - 1];
      if (prevRsi === null) {
        result.push(null);
        continue;
      }
      // Use smoothed averages
      const prevAvgGain = gains.slice(i - period, i - 1).reduce((a, b) => a + b, 0) / period;
      const prevAvgLoss = losses.slice(i - period, i - 1).reduce((a, b) => a + b, 0) / period;
      const avgGain = (prevAvgGain * (period - 1) + gains[i - 1]) / period;
      const avgLoss = (prevAvgLoss * (period - 1) + losses[i - 1]) / period;
      if (avgLoss === 0) {
        result.push(100);
      } else {
        const rs = avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      }
    }
  }
  return result;
}

function computeMACD(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const fastEMA = computeEMA(closes, fastPeriod);
  const slowEMA = computeEMA(closes, slowPeriod);

  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine.push(fastEMA[i]! - slowEMA[i]!);
    } else {
      macdLine.push(null);
    }
  }

  // Signal line is EMA of MACD line (skip nulls)
  const macdValues = macdLine.filter((v): v is number => v !== null);
  const signalEMA = computeEMA(macdValues, signalPeriod);

  // Align signal back to full-length array
  const signal: (number | null)[] = [];
  let macdIdx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) {
      signal.push(null);
    } else {
      signal.push(signalEMA[macdIdx] ?? null);
      macdIdx++;
    }
  }

  const histogram: (number | null)[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null && signal[i] !== null) {
      histogram.push(macdLine[i]! - signal[i]!);
    } else {
      histogram.push(null);
    }
  }

  return { macd: macdLine, signal, histogram };
}

function computeBollingerBands(
  closes: number[],
  period: number,
  stdDevMultiplier: number,
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const sma = computeSMA(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (sma[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sumSqDiff = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSqDiff += (closes[j] - sma[i]!) ** 2;
    }
    const stdDev = Math.sqrt(sumSqDiff / period);
    upper.push(sma[i]! + stdDevMultiplier * stdDev);
    lower.push(sma[i]! - stdDevMultiplier * stdDev);
  }

  return { upper, middle: sma, lower };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAnalyticsRouter(pool: Pool, redis: Redis): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Schemas
  // -----------------------------------------------------------------------

  const indicatorBodySchema = z.object({
    instrumentId: z.string().uuid(),
    indicator: z.enum(['SMA', 'EMA', 'RSI', 'MACD', 'BOLLINGER']),
    params: z.object({
      period: z.number().int().min(1).max(500).optional().default(14),
      fastPeriod: z.number().int().min(1).optional().default(12),
      slowPeriod: z.number().int().min(1).optional().default(26),
      signalPeriod: z.number().int().min(1).optional().default(9),
      stdDevMultiplier: z.number().min(0.1).max(5).optional().default(2),
      barSize: z.nativeEnum(BarSize).optional().default(BarSize.DAY_1),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(5000).optional().default(500),
    }).optional().default({}),
  });

  const correlationQuerySchema = z.object({
    instrumentIds: z
      .string()
      .transform((s) => s.split(',').map((id) => id.trim()))
      .pipe(z.array(z.string().uuid()).min(2).max(20)),
    period: z.coerce.number().int().min(5).max(1000).default(252),
    barSize: z.nativeEnum(BarSize).default(BarSize.DAY_1),
  });

  const portfolioBodySchema = z.object({
    holdings: z.array(
      z.object({
        instrumentId: z.string().uuid(),
        weight: z.number().min(0).max(1),
        shares: z.number().optional(),
        costBasis: z.number().optional(),
      }),
    ).min(1).max(100),
    benchmarkInstrumentId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    barSize: z.nativeEnum(BarSize).default(BarSize.DAY_1),
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function sendError(res: Response, req: Request, code: string, message: string, status: number): void {
    const error: ApiError = {
      code,
      message,
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(error);
  }

  async function fetchBars(
    instrumentId: string,
    barSize: string,
    from?: string,
    to?: string,
    limit?: number,
  ): Promise<OHLCV[]> {
    const conditions = ['instrument_id = $1', 'bar_size = $2'];
    const params: any[] = [instrumentId, barSize];
    let idx = 3;

    if (from) {
      conditions.push(`timestamp >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      conditions.push(`timestamp <= $${idx++}`);
      params.push(to);
    }

    const result = await pool.query(
      `SELECT timestamp, open, high, low, close, volume
       FROM ohlcv_bars
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC
       LIMIT $${idx}`,
      [...params, limit ?? 5000],
    );

    return result.rows.map((r: any) => ({
      timestamp: r.timestamp,
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));
  }

  // -----------------------------------------------------------------------
  // POST /api/v1/analytics/indicators
  // Compute technical indicators on-demand
  // -----------------------------------------------------------------------

  router.post(
    '/indicators',
    authenticate,
    requireRole(UserRole.ANALYST),
    validate({ body: indicatorBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { instrumentId, indicator, params } = req.body as z.infer<typeof indicatorBodySchema>;

        // Check cache
        const cacheKey = `indicator:${instrumentId}:${indicator}:${JSON.stringify(params)}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.json({ data: JSON.parse(cached), source: 'cache' });
          return;
        }

        const bars = await fetchBars(
          instrumentId,
          params.barSize,
          params.from,
          params.to,
          params.limit,
        );

        if (bars.length === 0) {
          sendError(res, req, 'NO_DATA', 'No price data found for the given parameters', 404);
          return;
        }

        const closes = bars.map((b) => b.close);
        let result: Record<string, unknown>;

        switch (indicator) {
          case 'SMA': {
            const values = computeSMA(closes, params.period);
            result = {
              indicator: 'SMA',
              period: params.period,
              values: bars.map((b, i) => ({
                timestamp: b.timestamp,
                value: values[i],
              })),
            };
            break;
          }
          case 'EMA': {
            const values = computeEMA(closes, params.period);
            result = {
              indicator: 'EMA',
              period: params.period,
              values: bars.map((b, i) => ({
                timestamp: b.timestamp,
                value: values[i],
              })),
            };
            break;
          }
          case 'RSI': {
            const values = computeRSI(closes, params.period);
            result = {
              indicator: 'RSI',
              period: params.period,
              values: bars.map((b, i) => ({
                timestamp: b.timestamp,
                value: values[i],
              })),
            };
            break;
          }
          case 'MACD': {
            const { macd, signal, histogram } = computeMACD(
              closes,
              params.fastPeriod,
              params.slowPeriod,
              params.signalPeriod,
            );
            result = {
              indicator: 'MACD',
              fastPeriod: params.fastPeriod,
              slowPeriod: params.slowPeriod,
              signalPeriod: params.signalPeriod,
              values: bars.map((b, i) => ({
                timestamp: b.timestamp,
                macd: macd[i],
                signal: signal[i],
                histogram: histogram[i],
              })),
            };
            break;
          }
          case 'BOLLINGER': {
            const { upper, middle, lower } = computeBollingerBands(
              closes,
              params.period,
              params.stdDevMultiplier,
            );
            result = {
              indicator: 'BOLLINGER',
              period: params.period,
              stdDevMultiplier: params.stdDevMultiplier,
              values: bars.map((b, i) => ({
                timestamp: b.timestamp,
                upper: upper[i],
                middle: middle[i],
                lower: lower[i],
              })),
            };
            break;
          }
          default:
            sendError(res, req, 'UNSUPPORTED_INDICATOR', `Indicator ${indicator} is not supported`, 400);
            return;
        }

        // Cache for 5 minutes
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/analytics/correlation
  // Cross-asset correlation matrix
  // -----------------------------------------------------------------------

  router.get(
    '/correlation',
    authenticate,
    requireRole(UserRole.ANALYST),
    validate({ query: correlationQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { instrumentIds, period, barSize } = validatedQuery<z.infer<typeof correlationQuerySchema>>(req);

        // Fetch returns for all instruments
        const returnSeries: Record<string, number[]> = {};
        const tickerMap: Record<string, string> = {};

        for (const id of instrumentIds) {
          const bars = await fetchBars(id, barSize, undefined, undefined, period + 1);
          if (bars.length < 2) {
            sendError(
              res,
              req,
              'INSUFFICIENT_DATA',
              `Not enough data for instrument ${id}`,
              400,
            );
            return;
          }

          // Daily log returns
          const returns: number[] = [];
          for (let i = 1; i < bars.length; i++) {
            returns.push(Math.log(bars[i].close / bars[i - 1].close));
          }
          returnSeries[id] = returns;

          // Fetch ticker for labelling
          const instResult = await pool.query(
            'SELECT primary_ticker FROM instruments WHERE id = $1',
            [id],
          );
          tickerMap[id] = instResult.rows[0]?.primary_ticker ?? id;
        }

        // Compute correlation matrix
        const ids = instrumentIds;
        const matrix: number[][] = [];

        for (let i = 0; i < ids.length; i++) {
          const row: number[] = [];
          for (let j = 0; j < ids.length; j++) {
            if (i === j) {
              row.push(1.0);
            } else {
              const x = returnSeries[ids[i]];
              const y = returnSeries[ids[j]];
              const n = Math.min(x.length, y.length);

              const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
              const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

              let covXY = 0;
              let varX = 0;
              let varY = 0;
              for (let k = 0; k < n; k++) {
                const dx = x[k] - meanX;
                const dy = y[k] - meanY;
                covXY += dx * dy;
                varX += dx * dx;
                varY += dy * dy;
              }

              const denom = Math.sqrt(varX * varY);
              row.push(denom === 0 ? 0 : covXY / denom);
            }
          }
          matrix.push(row);
        }

        const labels = ids.map((id) => tickerMap[id]);

        res.json({
          data: {
            labels,
            instrumentIds: ids,
            matrix,
            period,
            barSize,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/v1/analytics/portfolio/performance
  // Portfolio performance metrics
  // -----------------------------------------------------------------------

  router.post(
    '/portfolio/performance',
    authenticate,
    requireRole(UserRole.ANALYST),
    validate({ body: portfolioBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { holdings, benchmarkInstrumentId, from, to, barSize } =
          req.body as z.infer<typeof portfolioBodySchema>;

        // Fetch price series for each holding
        const holdingReturns: { id: string; weight: number; returns: number[] }[] = [];
        const TRADING_DAYS_PER_YEAR = 252;
        const RISK_FREE_RATE = 0.04; // Annualized

        for (const h of holdings) {
          const bars = await fetchBars(h.instrumentId, barSize, from, to, 5000);
          if (bars.length < 2) {
            sendError(res, req, 'INSUFFICIENT_DATA', `Not enough data for instrument ${h.instrumentId}`, 400);
            return;
          }

          const returns: number[] = [];
          for (let i = 1; i < bars.length; i++) {
            returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
          }
          holdingReturns.push({ id: h.instrumentId, weight: h.weight, returns });
        }

        // Calculate portfolio returns (weighted sum)
        const minLen = Math.min(...holdingReturns.map((h) => h.returns.length));
        const portfolioReturns: number[] = [];

        for (let i = 0; i < minLen; i++) {
          let portfolioReturn = 0;
          for (const h of holdingReturns) {
            portfolioReturn += h.weight * h.returns[i];
          }
          portfolioReturns.push(portfolioReturn);
        }

        // Cumulative returns
        const cumulativeReturns: number[] = [];
        let cumReturn = 1;
        for (const r of portfolioReturns) {
          cumReturn *= 1 + r;
          cumulativeReturns.push(cumReturn - 1);
        }

        // Annualized return
        const totalReturn = cumulativeReturns[cumulativeReturns.length - 1] ?? 0;
        const periodsPerYear = barSize === BarSize.DAY_1 ? TRADING_DAYS_PER_YEAR : 252;
        const annualizedReturn =
          minLen > 0
            ? Math.pow(1 + totalReturn, periodsPerYear / minLen) - 1
            : 0;

        // Volatility (annualized)
        const meanReturn = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
        const variance =
          portfolioReturns.reduce((acc, r) => acc + (r - meanReturn) ** 2, 0) /
          (portfolioReturns.length - 1 || 1);
        const annualizedVolatility = Math.sqrt(variance * periodsPerYear);

        // Sharpe ratio
        const dailyRiskFree = RISK_FREE_RATE / periodsPerYear;
        const excessReturns = portfolioReturns.map((r) => r - dailyRiskFree);
        const meanExcess = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
        const excessVariance =
          excessReturns.reduce((acc, r) => acc + (r - meanExcess) ** 2, 0) /
          (excessReturns.length - 1 || 1);
        const sharpeRatio = Math.sqrt(periodsPerYear) * (meanExcess / (Math.sqrt(excessVariance) || 1));

        // Sortino ratio (downside deviation)
        const downsideReturns = excessReturns.filter((r) => r < 0);
        const downsideVariance =
          downsideReturns.length > 0
            ? downsideReturns.reduce((acc, r) => acc + r ** 2, 0) / downsideReturns.length
            : 0;
        const sortinoRatio =
          downsideVariance > 0
            ? Math.sqrt(periodsPerYear) * (meanExcess / Math.sqrt(downsideVariance))
            : 0;

        // Maximum drawdown
        let peak = -Infinity;
        let maxDrawdown = 0;
        const cumValues = cumulativeReturns.map((r) => 1 + r);
        for (const val of cumValues) {
          if (val > peak) peak = val;
          const drawdown = (peak - val) / peak;
          if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        // Benchmark comparison (if provided)
        let benchmarkMetrics: Record<string, number> | null = null;
        if (benchmarkInstrumentId) {
          const benchBars = await fetchBars(benchmarkInstrumentId, barSize, from, to, 5000);
          if (benchBars.length >= 2) {
            const benchReturns: number[] = [];
            for (let i = 1; i < benchBars.length; i++) {
              benchReturns.push((benchBars[i].close - benchBars[i - 1].close) / benchBars[i - 1].close);
            }
            const benchLen = Math.min(benchReturns.length, minLen);
            const benchTotal = benchReturns.slice(0, benchLen).reduce((cum, r) => cum * (1 + r), 1) - 1;
            const alpha = totalReturn - benchTotal;

            // Beta
            const portSlice = portfolioReturns.slice(0, benchLen);
            const benchSlice = benchReturns.slice(0, benchLen);
            const meanPort = portSlice.reduce((a, b) => a + b, 0) / benchLen;
            const meanBench = benchSlice.reduce((a, b) => a + b, 0) / benchLen;
            let covariance = 0;
            let benchVariance2 = 0;
            for (let i = 0; i < benchLen; i++) {
              covariance += (portSlice[i] - meanPort) * (benchSlice[i] - meanBench);
              benchVariance2 += (benchSlice[i] - meanBench) ** 2;
            }
            const beta = benchVariance2 > 0 ? covariance / benchVariance2 : 0;

            benchmarkMetrics = {
              benchmarkReturn: benchTotal,
              alpha,
              beta,
              trackingError: Math.sqrt(
                portSlice.reduce((acc, r, i) => acc + (r - benchSlice[i]) ** 2, 0) / benchLen,
              ) * Math.sqrt(periodsPerYear),
            };
          }
        }

        res.json({
          data: {
            totalReturn,
            annualizedReturn,
            annualizedVolatility,
            sharpeRatio,
            sortinoRatio,
            maxDrawdown,
            periods: minLen,
            riskFreeRate: RISK_FREE_RATE,
            benchmark: benchmarkMetrics,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
