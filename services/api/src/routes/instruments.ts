import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { validate, validatedQuery } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import {
  InstrumentType,
  BarSize,
  CorporateActionType,
  type Instrument,
  type OHLCVBar,
  type CompanyFundamentals,
  type EarningsEvent,
  type CorporateAction,
  type PaginatedResponse,
  type ApiError,
} from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Database pool — injected via factory
// ---------------------------------------------------------------------------

export function createInstrumentsRouter(pool: Pool): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Shared validation schemas
  // -----------------------------------------------------------------------

  const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    sortBy: z.string().default('primaryTicker'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  });

  const instrumentListSchema = paginationSchema.extend({
    type: z.nativeEnum(InstrumentType).optional(),
    exchange: z.string().optional(),
    ticker: z.string().optional(),
    isActive: z.preprocess((v) => {
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v;
    }, z.boolean().optional()),
    country: z.string().length(2).optional(),
    sector: z.string().optional(),
  });

  const idParamSchema = z.object({
    id: z.string().uuid(),
  });

  const searchQuerySchema = paginationSchema.extend({
    q: z.string().min(1).max(100),
  });

  const barsQuerySchema = z.object({
    barSize: z.nativeEnum(BarSize).default(BarSize.DAY_1),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
    adjusted: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(true)),
  });

  const fundamentalsQuerySchema = paginationSchema.extend({
    period: z.enum(['Q1', 'Q2', 'Q3', 'Q4', 'FY']).optional(),
    fiscalYear: z.coerce.number().int().optional(),
  });

  const earningsQuerySchema = paginationSchema.extend({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  });

  const corporateActionsQuerySchema = paginationSchema.extend({
    type: z.nativeEnum(CorporateActionType).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  });

  // Allowed sort columns (whitelist to prevent SQL injection in ORDER BY)
  const INSTRUMENT_SORT_COLUMNS = new Set([
    'primaryTicker', 'name', 'type', 'assetClass', 'currency', 'country',
    'sector', 'industry', 'createdAt', 'updatedAt',
  ]);

  const COLUMN_MAP: Record<string, string> = {
    primaryTicker: 'primary_ticker',
    assetClass: 'asset_class',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    primaryExchangeMic: 'primary_exchange_mic',
    isActive: 'is_active',
    delistedAt: 'delisted_at',
    tickerAliases: 'ticker_aliases',
  };

  function toSnake(col: string): string {
    return COLUMN_MAP[col] ?? col;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function buildPaginatedResponse<T>(
    rows: T[],
    totalItems: number,
    page: number,
    pageSize: number,
  ): PaginatedResponse<T> {
    const totalPages = Math.ceil(totalItems / pageSize);
    return {
      data: rows,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  function instrumentFromRow(row: any): Instrument {
    return {
      id: row.id,
      isin: row.isin,
      figi: row.figi,
      type: row.type,
      assetClass: row.asset_class,
      name: row.name,
      primaryTicker: row.primary_ticker,
      primaryExchangeMic: row.primary_exchange_mic,
      currency: row.currency,
      tickerAliases: row.ticker_aliases ?? [],
      country: row.country,
      sector: row.sector,
      industry: row.industry,
      isActive: row.is_active,
      delistedAt: row.delisted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function apiError(code: string, message: string, req: Request, status: number, res: Response): void {
    const error: ApiError = {
      code,
      message,
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(error);
  }

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/search?q=AAPL
  // Full-text search across ticker, name, ISIN
  // NOTE: This route is declared BEFORE /:id to avoid param collision.
  // -----------------------------------------------------------------------

  router.get(
    '/search',
    authenticate,
    validate({ query: searchQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { q, page, pageSize, sortBy, sortOrder } = validatedQuery<z.infer<typeof searchQuerySchema>>(req);
        const safeSortCol = INSTRUMENT_SORT_COLUMNS.has(sortBy) ? toSnake(sortBy) : 'primary_ticker';
        const safeOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';
        const searchPattern = `%${q}%`;
        const offset = (page - 1) * pageSize;

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total
           FROM instruments
           WHERE primary_ticker ILIKE $1
              OR name ILIKE $1
              OR isin ILIKE $1
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(ticker_aliases) AS alias
                WHERE alias->>'ticker' ILIKE $1
              )`,
          [searchPattern],
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const dataResult = await pool.query(
          `SELECT *
           FROM instruments
           WHERE primary_ticker ILIKE $1
              OR name ILIKE $1
              OR isin ILIKE $1
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(ticker_aliases) AS alias
                WHERE alias->>'ticker' ILIKE $1
              )
           ORDER BY ${safeSortCol} ${safeOrder}
           LIMIT $2 OFFSET $3`,
          [searchPattern, pageSize, offset],
        );

        const instruments = dataResult.rows.map(instrumentFromRow);
        res.json(buildPaginatedResponse(instruments, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments
  // List with pagination, filtering by type/exchange/ticker
  // -----------------------------------------------------------------------

  router.get(
    '/',
    authenticate,
    validate({ query: instrumentListSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = validatedQuery<z.infer<typeof instrumentListSchema>>(req);
        const { page, pageSize, sortBy, sortOrder, type, exchange, ticker, isActive, country, sector } = query;

        const safeSortCol = INSTRUMENT_SORT_COLUMNS.has(sortBy) ? toSnake(sortBy) : 'primary_ticker';
        const safeOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';

        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (type !== undefined) {
          conditions.push(`type = $${paramIndex++}`);
          values.push(type);
        }
        if (exchange !== undefined) {
          conditions.push(`primary_exchange_mic = $${paramIndex++}`);
          values.push(exchange);
        }
        if (ticker !== undefined) {
          conditions.push(`primary_ticker ILIKE $${paramIndex++}`);
          values.push(`%${ticker}%`);
        }
        if (isActive !== undefined) {
          conditions.push(`is_active = $${paramIndex++}`);
          values.push(isActive);
        }
        if (country !== undefined) {
          conditions.push(`country = $${paramIndex++}`);
          values.push(country);
        }
        if (sector !== undefined) {
          conditions.push(`sector = $${paramIndex++}`);
          values.push(sector);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM instruments ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const dataResult = await pool.query(
          `SELECT * FROM instruments ${whereClause}
           ORDER BY ${safeSortCol} ${safeOrder}
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const instruments = dataResult.rows.map(instrumentFromRow);
        res.json(buildPaginatedResponse(instruments, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/:id
  // -----------------------------------------------------------------------

  router.get(
    '/:id',
    authenticate,
    validate({ params: idParamSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM instruments WHERE id = $1', [id]);

        if (result.rows.length === 0) {
          apiError('NOT_FOUND', `Instrument ${id} not found`, req, 404, res);
          return;
        }

        res.json({ data: instrumentFromRow(result.rows[0]) });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/:id/bars
  // OHLCV data with bar_size, from, to params
  // -----------------------------------------------------------------------

  router.get(
    '/:id/bars',
    authenticate,
    validate({ params: idParamSchema, query: barsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { barSize, from, to, limit, adjusted } = validatedQuery<z.infer<typeof barsQuerySchema>>(req);

        // Verify instrument exists
        const instResult = await pool.query('SELECT id FROM instruments WHERE id = $1', [id]);
        if (instResult.rows.length === 0) {
          apiError('NOT_FOUND', `Instrument ${id} not found`, req, 404, res);
          return;
        }

        const conditions: string[] = ['instrument_id = $1', 'bar_size = $2'];
        const values: any[] = [id, barSize];
        let paramIndex = 3;

        if (adjusted !== undefined) {
          conditions.push(`is_adjusted = $${paramIndex++}`);
          values.push(adjusted);
        }
        if (from) {
          conditions.push(`timestamp >= $${paramIndex++}`);
          values.push(from);
        }
        if (to) {
          conditions.push(`timestamp <= $${paramIndex++}`);
          values.push(to);
        }

        const whereClause = conditions.join(' AND ');
        const result = await pool.query(
          `SELECT * FROM ohlcv_bars
           WHERE ${whereClause}
           ORDER BY timestamp ASC
           LIMIT $${paramIndex}`,
          [...values, limit],
        );

        const bars: OHLCVBar[] = result.rows.map((row: any) => ({
          instrumentId: row.instrument_id,
          timestamp: row.timestamp,
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
          volume: parseFloat(row.volume),
          vwap: row.vwap != null ? parseFloat(row.vwap) : null,
          trades: row.trades != null ? parseInt(row.trades, 10) : null,
          barSize: row.bar_size,
          isAdjusted: row.is_adjusted,
          source: row.source,
        }));

        res.json({ data: bars, count: bars.length });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/:id/fundamentals
  // -----------------------------------------------------------------------

  router.get(
    '/:id/fundamentals',
    authenticate,
    validate({ params: idParamSchema, query: fundamentalsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { page, pageSize, sortBy, sortOrder, period, fiscalYear } =
          validatedQuery<z.infer<typeof fundamentalsQuerySchema>>(req);

        const conditions: string[] = ['instrument_id = $1'];
        const values: any[] = [id];
        let paramIndex = 2;

        if (period) {
          conditions.push(`period = $${paramIndex++}`);
          values.push(period);
        }
        if (fiscalYear) {
          conditions.push(`fiscal_year = $${paramIndex++}`);
          values.push(fiscalYear);
        }

        const whereClause = conditions.join(' AND ');

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM company_fundamentals WHERE ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const result = await pool.query(
          `SELECT * FROM company_fundamentals
           WHERE ${whereClause}
           ORDER BY fiscal_year DESC, period DESC
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const fundamentals: CompanyFundamentals[] = result.rows.map((row: any) => ({
          instrumentId: row.instrument_id,
          reportDate: row.report_date,
          period: row.period,
          fiscalYear: row.fiscal_year,
          revenue: row.revenue != null ? parseFloat(row.revenue) : null,
          netIncome: row.net_income != null ? parseFloat(row.net_income) : null,
          eps: row.eps != null ? parseFloat(row.eps) : null,
          epsEstimate: row.eps_estimate != null ? parseFloat(row.eps_estimate) : null,
          marketCap: row.market_cap != null ? parseFloat(row.market_cap) : null,
          peRatio: row.pe_ratio != null ? parseFloat(row.pe_ratio) : null,
          pbRatio: row.pb_ratio != null ? parseFloat(row.pb_ratio) : null,
          debtToEquity: row.debt_to_equity != null ? parseFloat(row.debt_to_equity) : null,
          dividendYield: row.dividend_yield != null ? parseFloat(row.dividend_yield) : null,
          freeCashFlow: row.free_cash_flow != null ? parseFloat(row.free_cash_flow) : null,
          currency: row.currency,
          source: row.source,
          updatedAt: row.updated_at,
        }));

        res.json(buildPaginatedResponse(fundamentals, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/:id/earnings
  // -----------------------------------------------------------------------

  router.get(
    '/:id/earnings',
    authenticate,
    validate({ params: idParamSchema, query: earningsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { page, pageSize, fromDate, toDate } =
          validatedQuery<z.infer<typeof earningsQuerySchema>>(req);

        const conditions: string[] = ['instrument_id = $1'];
        const values: any[] = [id];
        let paramIndex = 2;

        if (fromDate) {
          conditions.push(`report_date >= $${paramIndex++}`);
          values.push(fromDate);
        }
        if (toDate) {
          conditions.push(`report_date <= $${paramIndex++}`);
          values.push(toDate);
        }

        const whereClause = conditions.join(' AND ');

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM earnings_events WHERE ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const result = await pool.query(
          `SELECT * FROM earnings_events
           WHERE ${whereClause}
           ORDER BY report_date DESC
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const earnings: EarningsEvent[] = result.rows.map((row: any) => ({
          instrumentId: row.instrument_id,
          reportDate: row.report_date,
          fiscalQuarter: row.fiscal_quarter,
          epsActual: row.eps_actual != null ? parseFloat(row.eps_actual) : null,
          epsEstimate: row.eps_estimate != null ? parseFloat(row.eps_estimate) : null,
          revenueActual: row.revenue_actual != null ? parseFloat(row.revenue_actual) : null,
          revenueEstimate: row.revenue_estimate != null ? parseFloat(row.revenue_estimate) : null,
          surprise: row.surprise != null ? parseFloat(row.surprise) : null,
          transcriptUrl: row.transcript_url,
          source: row.source,
        }));

        res.json(buildPaginatedResponse(earnings, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/instruments/:id/corporate-actions
  // -----------------------------------------------------------------------

  router.get(
    '/:id/corporate-actions',
    authenticate,
    validate({ params: idParamSchema, query: corporateActionsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { page, pageSize, type, fromDate, toDate } =
          validatedQuery<z.infer<typeof corporateActionsQuerySchema>>(req);

        const conditions: string[] = ['instrument_id = $1'];
        const values: any[] = [id];
        let paramIndex = 2;

        if (type) {
          conditions.push(`type = $${paramIndex++}`);
          values.push(type);
        }
        if (fromDate) {
          conditions.push(`ex_date >= $${paramIndex++}`);
          values.push(fromDate);
        }
        if (toDate) {
          conditions.push(`ex_date <= $${paramIndex++}`);
          values.push(toDate);
        }

        const whereClause = conditions.join(' AND ');

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM corporate_actions WHERE ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const result = await pool.query(
          `SELECT * FROM corporate_actions
           WHERE ${whereClause}
           ORDER BY ex_date DESC
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const actions: CorporateAction[] = result.rows.map((row: any) => ({
          id: row.id,
          instrumentId: row.instrument_id,
          type: row.type,
          exDate: row.ex_date,
          recordDate: row.record_date,
          paymentDate: row.payment_date,
          ratio: row.ratio != null ? parseFloat(row.ratio) : null,
          amount: row.amount != null ? parseFloat(row.amount) : null,
          currency: row.currency,
          description: row.description,
          source: row.source,
          createdAt: row.created_at,
        }));

        res.json(buildPaginatedResponse(actions, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
