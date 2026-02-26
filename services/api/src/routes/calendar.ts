import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { validate, validatedQuery } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import {
  MacroCategory,
  type MacroEvent,
  type EarningsEvent,
  type PaginatedResponse,
  type ApiError,
} from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCalendarRouter(pool: Pool): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Schemas
  // -----------------------------------------------------------------------

  const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  });

  const macroQuerySchema = paginationSchema.extend({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    country: z.string().length(2).optional(),
    category: z.nativeEnum(MacroCategory).optional(),
    impact: z.enum(['high', 'medium', 'low']).optional(),
  });

  const earningsQuerySchema = paginationSchema.extend({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    ticker: z.string().optional(),
  });

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

  function macroEventFromRow(row: any): MacroEvent {
    return {
      id: row.id,
      name: row.name,
      country: row.country,
      category: row.category,
      scheduledAt: row.scheduled_at,
      actual: row.actual != null ? parseFloat(row.actual) : null,
      forecast: row.forecast != null ? parseFloat(row.forecast) : null,
      previous: row.previous != null ? parseFloat(row.previous) : null,
      unit: row.unit,
      impact: row.impact,
      source: row.source,
    };
  }

  function earningsFromRow(row: any): EarningsEvent {
    return {
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
    };
  }

  // -----------------------------------------------------------------------
  // GET /api/v1/calendar/macro
  // Macro events with date range, country, category, impact filters
  // -----------------------------------------------------------------------

  router.get(
    '/macro',
    authenticate,
    validate({ query: macroQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { page, pageSize, from, to, country, category, impact } =
          validatedQuery<z.infer<typeof macroQuerySchema>>(req);

        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (from) {
          conditions.push(`scheduled_at >= $${paramIndex++}`);
          values.push(from);
        }
        if (to) {
          conditions.push(`scheduled_at <= $${paramIndex++}`);
          values.push(to);
        }
        if (country) {
          conditions.push(`country = $${paramIndex++}`);
          values.push(country);
        }
        if (category) {
          conditions.push(`category = $${paramIndex++}`);
          values.push(category);
        }
        if (impact) {
          conditions.push(`impact = $${paramIndex++}`);
          values.push(impact);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM macro_events ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const dataResult = await pool.query(
          `SELECT * FROM macro_events ${whereClause}
           ORDER BY scheduled_at ASC
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const events = dataResult.rows.map(macroEventFromRow);
        res.json(buildPaginatedResponse(events, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/calendar/earnings
  // Upcoming earnings events with date range, optional ticker filter
  // -----------------------------------------------------------------------

  router.get(
    '/earnings',
    authenticate,
    validate({ query: earningsQuerySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { page, pageSize, from, to, ticker } =
          validatedQuery<z.infer<typeof earningsQuerySchema>>(req);

        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (from) {
          conditions.push(`e.report_date >= $${paramIndex++}`);
          values.push(from);
        }
        if (to) {
          conditions.push(`e.report_date <= $${paramIndex++}`);
          values.push(to);
        }
        if (ticker) {
          conditions.push(`i.primary_ticker ILIKE $${paramIndex++}`);
          values.push(`%${ticker}%`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total
           FROM earnings_events e
           INNER JOIN instruments i ON i.id = e.instrument_id
           ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const dataResult = await pool.query(
          `SELECT e.*, i.primary_ticker, i.name AS instrument_name
           FROM earnings_events e
           INNER JOIN instruments i ON i.id = e.instrument_id
           ${whereClause}
           ORDER BY e.report_date ASC
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const earnings = dataResult.rows.map((row: any) => ({
          ...earningsFromRow(row),
          ticker: row.primary_ticker,
          instrumentName: row.instrument_name,
        }));

        res.json(buildPaginatedResponse(earnings, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
