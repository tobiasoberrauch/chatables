import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { validate, validatedQuery } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import type { ApiError, Quote } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createMarketDataRouter(pool: Pool, redis: Redis): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Validation schemas
  // -----------------------------------------------------------------------

  const tickerParamSchema = z.object({
    ticker: z.string().min(1).max(20).toUpperCase(),
  });

  const fxPairParamSchema = z.object({
    pair: z
      .string()
      .regex(/^[A-Z]{3}[A-Z]{3}$/, 'Pair must be 6 uppercase letters, e.g. EURUSD')
      .transform((p) => p.toUpperCase()),
  });

  const moversQuerySchema = z.object({
    direction: z.enum(['gainers', 'losers', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    exchange: z.string().optional(),
    type: z.string().optional(),
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function sendApiError(
    res: Response,
    req: Request,
    code: string,
    message: string,
    status: number,
  ): void {
    const error: ApiError = {
      code,
      message,
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(error);
  }

  // -----------------------------------------------------------------------
  // GET /api/v1/market-data/quotes/:ticker
  //
  // Returns the most recent quote for the given ticker. First checks the
  // Redis cache (`quote:{TICKER}`), then falls back to PostgreSQL.
  // -----------------------------------------------------------------------

  router.get(
    '/quotes/:ticker',
    authenticate,
    validate({ params: tickerParamSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { ticker } = req.params;

        // Attempt Redis first — real-time data is pushed here by market data ingestion
        const cacheKey = `quote:${ticker}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
          const quote = JSON.parse(cached);
          res.json({ data: quote, source: 'realtime' });
          return;
        }

        // Fallback: latest quote from the database via the instrument's primary ticker
        const result = await pool.query(
          `SELECT q.*
           FROM quotes q
           INNER JOIN instruments i ON i.id = q.instrument_id
           WHERE i.primary_ticker = $1
           ORDER BY q.timestamp DESC
           LIMIT 1`,
          [ticker],
        );

        if (result.rows.length === 0) {
          sendApiError(res, req, 'NOT_FOUND', `No quote found for ticker ${ticker}`, 404);
          return;
        }

        const row = result.rows[0];
        const quote: Quote = {
          instrumentId: row.instrument_id,
          timestamp: row.timestamp,
          bidPrice: parseFloat(row.bid_price),
          bidSize: parseFloat(row.bid_size),
          askPrice: parseFloat(row.ask_price),
          askSize: parseFloat(row.ask_size),
          bidExchangeMic: row.bid_exchange_mic,
          askExchangeMic: row.ask_exchange_mic,
        };

        // Cache for a short period so subsequent hits are fast
        await redis.set(cacheKey, JSON.stringify(quote), 'EX', 5);

        res.json({ data: quote, source: 'database' });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/market-data/fx/:pair
  //
  // Returns latest FX rate. Pair format: EURUSD (base=EUR, quote=USD).
  // -----------------------------------------------------------------------

  router.get(
    '/fx/:pair',
    authenticate,
    validate({ params: fxPairParamSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pair = req.params.pair.toUpperCase();
        const base = pair.slice(0, 3);
        const quote = pair.slice(3, 6);

        // Redis first
        const cacheKey = `fx:${pair}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
          res.json({ data: JSON.parse(cached), source: 'realtime' });
          return;
        }

        // Fallback to database
        const result = await pool.query(
          `SELECT q.*, i.primary_ticker
           FROM quotes q
           INNER JOIN instruments i ON i.id = q.instrument_id
           WHERE i.type = 'FX'
             AND i.primary_ticker = $1
           ORDER BY q.timestamp DESC
           LIMIT 1`,
          [`${base}/${quote}`],
        );

        if (result.rows.length === 0) {
          // Try reversed pair
          const reversedResult = await pool.query(
            `SELECT q.*, i.primary_ticker
             FROM quotes q
             INNER JOIN instruments i ON i.id = q.instrument_id
             WHERE i.type = 'FX'
               AND i.primary_ticker = $1
             ORDER BY q.timestamp DESC
             LIMIT 1`,
            [`${quote}/${base}`],
          );

          if (reversedResult.rows.length === 0) {
            sendApiError(res, req, 'NOT_FOUND', `No FX rate found for pair ${pair}`, 404);
            return;
          }

          const row = reversedResult.rows[0];
          const rate = 1 / parseFloat(row.bid_price);
          const fxData = {
            pair,
            base,
            quote: quote,
            rate,
            bid: 1 / parseFloat(row.ask_price),
            ask: 1 / parseFloat(row.bid_price),
            timestamp: row.timestamp,
            inverted: true,
          };

          await redis.set(cacheKey, JSON.stringify(fxData), 'EX', 10);
          res.json({ data: fxData, source: 'database' });
          return;
        }

        const row = result.rows[0];
        const fxData = {
          pair,
          base,
          quote: quote,
          rate: parseFloat(row.bid_price),
          bid: parseFloat(row.bid_price),
          ask: parseFloat(row.ask_price),
          timestamp: row.timestamp,
          inverted: false,
        };

        await redis.set(cacheKey, JSON.stringify(fxData), 'EX', 10);
        res.json({ data: fxData, source: 'database' });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/market-data/movers
  //
  // Top gainers / losers. Uses a Redis sorted set that is populated by a
  // background job computing daily returns. Falls back to a DB query.
  // -----------------------------------------------------------------------

  router.get(
    '/movers',
    authenticate,
    validate({ query: moversQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { direction, limit, exchange, type } = validatedQuery<z.infer<typeof moversQuerySchema>>(req);

        // Attempt Redis sorted set (populated by market-data pipeline)
        const redisKey = 'movers:daily';
        const cached = await redis.get(redisKey);

        if (cached) {
          let movers: any[] = JSON.parse(cached);

          // Apply filters
          if (exchange) {
            movers = movers.filter((m: any) => m.exchange === exchange);
          }
          if (type) {
            movers = movers.filter((m: any) => m.type === type);
          }

          // Sort and slice
          if (direction === 'gainers') {
            movers = movers
              .filter((m: any) => m.changePercent > 0)
              .sort((a: any, b: any) => b.changePercent - a.changePercent)
              .slice(0, limit);
          } else if (direction === 'losers') {
            movers = movers
              .filter((m: any) => m.changePercent < 0)
              .sort((a: any, b: any) => a.changePercent - b.changePercent)
              .slice(0, limit);
          } else {
            movers = movers
              .sort((a: any, b: any) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
              .slice(0, limit);
          }

          res.json({ data: movers, source: 'realtime' });
          return;
        }

        // Fallback: compute from latest bars
        const dirFilter =
          direction === 'gainers'
            ? 'AND change_percent > 0'
            : direction === 'losers'
              ? 'AND change_percent < 0'
              : '';

        const exchangeFilter = exchange ? `AND i.primary_exchange_mic = $2` : '';
        const typeFilter = type
          ? `AND i.type = $${exchange ? 3 : 2}`
          : '';
        const orderClause =
          direction === 'gainers'
            ? 'ORDER BY change_percent DESC'
            : direction === 'losers'
              ? 'ORDER BY change_percent ASC'
              : 'ORDER BY ABS(change_percent) DESC';

        const params: any[] = [limit];
        if (exchange) params.push(exchange);
        if (type) params.push(type);

        const result = await pool.query(
          `SELECT
             i.id,
             i.primary_ticker AS ticker,
             i.name,
             i.type,
             i.primary_exchange_mic AS exchange,
             b.close AS price,
             b.close - b.open AS change,
             CASE WHEN b.open != 0 THEN ((b.close - b.open) / b.open) * 100 ELSE 0 END AS change_percent,
             b.volume
           FROM ohlcv_bars b
           INNER JOIN instruments i ON i.id = b.instrument_id
           WHERE b.bar_size = '1d'
             AND b.timestamp = (
               SELECT MAX(timestamp) FROM ohlcv_bars WHERE bar_size = '1d' AND instrument_id = b.instrument_id
             )
             ${dirFilter}
             ${exchangeFilter}
             ${typeFilter}
           ${orderClause}
           LIMIT $1`,
          params,
        );

        const movers = result.rows.map((row: any) => ({
          instrumentId: row.id,
          ticker: row.ticker,
          name: row.name,
          type: row.type,
          exchange: row.exchange,
          price: parseFloat(row.price),
          change: parseFloat(row.change),
          changePercent: parseFloat(row.change_percent),
          volume: parseFloat(row.volume),
        }));

        // Cache result for 60 seconds
        await redis.set(redisKey, JSON.stringify(movers), 'EX', 60);

        res.json({ data: movers, source: 'database' });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
