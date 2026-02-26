import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { validate, validatedQuery } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import type {
  NewsArticle,
  PaginatedResponse,
  ApiError,
} from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createNewsRouter(pool: Pool): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // Schemas
  // -----------------------------------------------------------------------

  const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sortBy: z.enum(['publishedAt', 'sentimentScore', 'source']).default('publishedAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  });

  const newsListSchema = paginationSchema.extend({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    sentiment: z.enum(['bearish', 'neutral', 'bullish']).optional(),
    source: z.string().optional(),
    category: z.string().optional(),
    ticker: z.string().optional(),
  });

  const newsIdParamSchema = z.object({
    id: z.string().uuid(),
  });

  const instrumentNewsParamSchema = z.object({
    instrumentId: z.string().uuid(),
  });

  const SORT_COLUMN_MAP: Record<string, string> = {
    publishedAt: 'published_at',
    sentimentScore: 'sentiment_score',
    source: 'source',
  };

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function newsFromRow(row: any): NewsArticle {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      content: row.content,
      url: row.url,
      source: row.source,
      publishedAt: row.published_at,
      instrumentIds: row.instrument_ids ?? [],
      tickers: row.tickers ?? [],
      sentimentScore: row.sentiment_score != null ? parseFloat(row.sentiment_score) : null,
      sentimentLabel: row.sentiment_label,
      categories: row.categories ?? [],
      createdAt: row.created_at,
    };
  }

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

  function sendError(res: Response, req: Request, code: string, message: string, status: number): void {
    const error: ApiError = {
      code,
      message,
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(error);
  }

  // -----------------------------------------------------------------------
  // GET /api/v1/news
  // List articles with pagination, date range, sentiment filter
  // -----------------------------------------------------------------------

  router.get(
    '/',
    authenticate,
    validate({ query: newsListSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { page, pageSize, sortBy, sortOrder, from, to, sentiment, source, category, ticker } =
          validatedQuery<z.infer<typeof newsListSchema>>(req);

        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (from) {
          conditions.push(`published_at >= $${paramIndex++}`);
          values.push(from);
        }
        if (to) {
          conditions.push(`published_at <= $${paramIndex++}`);
          values.push(to);
        }
        if (sentiment) {
          conditions.push(`sentiment_label = $${paramIndex++}`);
          values.push(sentiment);
        }
        if (source) {
          conditions.push(`source = $${paramIndex++}`);
          values.push(source);
        }
        if (category) {
          conditions.push(`$${paramIndex++} = ANY(categories)`);
          values.push(category);
        }
        if (ticker) {
          conditions.push(`$${paramIndex++} = ANY(tickers)`);
          values.push(ticker);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sortCol = SORT_COLUMN_MAP[sortBy] ?? 'published_at';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM news_articles ${whereClause}`,
          values,
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const dataResult = await pool.query(
          `SELECT * FROM news_articles ${whereClause}
           ORDER BY ${sortCol} ${order}
           LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
          [...values, pageSize, offset],
        );

        const articles = dataResult.rows.map(newsFromRow);
        res.json(buildPaginatedResponse(articles, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/news/:id
  // Single article
  // -----------------------------------------------------------------------

  router.get(
    '/:id',
    authenticate,
    validate({ params: newsIdParamSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM news_articles WHERE id = $1', [id]);

        if (result.rows.length === 0) {
          sendError(res, req, 'NOT_FOUND', `News article ${id} not found`, 404);
          return;
        }

        res.json({ data: newsFromRow(result.rows[0]) });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/news/instrument/:instrumentId
  // News articles related to a specific instrument
  // -----------------------------------------------------------------------

  router.get(
    '/instrument/:instrumentId',
    authenticate,
    validate({ params: instrumentNewsParamSchema, query: paginationSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { instrumentId } = req.params;
        const { page, pageSize, sortBy, sortOrder } = validatedQuery<z.infer<typeof paginationSchema>>(req);

        const sortCol = SORT_COLUMN_MAP[sortBy] ?? 'published_at';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM news_articles WHERE $1 = ANY(instrument_ids)`,
          [instrumentId],
        );
        const totalItems = parseInt(countResult.rows[0].total, 10);

        const offset = (page - 1) * pageSize;
        const dataResult = await pool.query(
          `SELECT * FROM news_articles
           WHERE $1 = ANY(instrument_ids)
           ORDER BY ${sortCol} ${order}
           LIMIT $2 OFFSET $3`,
          [instrumentId, pageSize, offset],
        );

        const articles = dataResult.rows.map(newsFromRow);
        res.json(buildPaginatedResponse(articles, totalItems, page, pageSize));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
