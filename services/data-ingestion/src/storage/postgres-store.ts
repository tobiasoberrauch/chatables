/**
 * PostgreSQL storage layer for normalized market data.
 *
 * Uses parameterized queries throughout (no string interpolation).
 * All writes are idempotent via ON CONFLICT.
 */

import { Logger } from '../../../../shared/src/utils/logger';
import type {
  Instrument,
  OHLCVBar,
  CorporateAction,
  CompanyFundamentals,
  EarningsEvent,
  MacroEvent,
  NewsArticle,
} from '../../../../shared/src/types/instrument';

const logger = new Logger('postgres-store');

/**
 * Minimal interface for a pg Pool-compatible client.
 * Allows injection of real pg.Pool or mocks.
 */
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export class PostgresStore {
  constructor(private readonly pool: PgPool) {}

  // ─── Instruments ───

  async upsertInstrument(instrument: Instrument): Promise<void> {
    const sql = `
      INSERT INTO instruments (
        id, isin, figi, type, asset_class, name, primary_ticker,
        primary_exchange_mic, currency, country, sector, industry,
        is_active, delisted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET
        isin = EXCLUDED.isin,
        figi = EXCLUDED.figi,
        name = EXCLUDED.name,
        primary_ticker = EXCLUDED.primary_ticker,
        primary_exchange_mic = EXCLUDED.primary_exchange_mic,
        currency = EXCLUDED.currency,
        sector = EXCLUDED.sector,
        industry = EXCLUDED.industry,
        is_active = EXCLUDED.is_active,
        delisted_at = EXCLUDED.delisted_at,
        updated_at = NOW()
    `;

    await this.pool.query(sql, [
      instrument.id,
      instrument.isin,
      instrument.figi,
      instrument.type,
      instrument.assetClass,
      instrument.name,
      instrument.primaryTicker,
      instrument.primaryExchangeMic,
      instrument.currency,
      instrument.country,
      instrument.sector,
      instrument.industry,
      instrument.isActive,
      instrument.delistedAt,
    ]);

    // Upsert ticker aliases
    for (const alias of instrument.tickerAliases) {
      await this.upsertTickerAlias(instrument.id, alias.source, alias.ticker, alias.exchangeMic);
    }

    logger.debug('Upserted instrument', {
      id: instrument.id,
      ticker: instrument.primaryTicker,
    });
  }

  private async upsertTickerAlias(
    instrumentId: string,
    source: string,
    ticker: string,
    exchangeMic?: string,
  ): Promise<void> {
    const sql = `
      INSERT INTO ticker_aliases (instrument_id, source, ticker, exchange_mic)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (source, ticker, exchange_mic) DO UPDATE SET
        instrument_id = EXCLUDED.instrument_id
    `;
    await this.pool.query(sql, [instrumentId, source, ticker, exchangeMic ?? null]);
  }

  async findInstrumentByTicker(
    source: string,
    ticker: string,
  ): Promise<string | null> {
    const sql = `
      SELECT instrument_id FROM ticker_aliases
      WHERE source = $1 AND ticker = $2
      LIMIT 1
    `;
    const result = await this.pool.query(sql, [source, ticker]);
    return result.rows.length > 0 ? (result.rows[0].instrument_id as string) : null;
  }

  async getInstrument(id: string): Promise<Record<string, unknown> | null> {
    const sql = `SELECT * FROM instruments WHERE id = $1`;
    const result = await this.pool.query(sql, [id]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async listInstruments(params: {
    type?: string;
    isActive?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (params.type) {
      conditions.push(`type = $${paramIdx++}`);
      values.push(params.type);
    }
    if (params.isActive !== undefined) {
      conditions.push(`is_active = $${paramIdx++}`);
      values.push(params.isActive);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) as total FROM instruments ${where}`;
    const countResult = await this.pool.query(countSql, values);
    const total = parseInt(countResult.rows[0].total as string, 10);

    const dataSql = `
      SELECT * FROM instruments ${where}
      ORDER BY primary_ticker ASC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataResult = await this.pool.query(dataSql, [...values, params.limit, params.offset]);

    return { rows: dataResult.rows, total };
  }

  // ─── OHLCV Bars ───

  /**
   * Batch insert OHLCV bars. Uses ON CONFLICT for idempotency.
   * Batches of 500 for optimal throughput.
   */
  async insertBars(bars: OHLCVBar[]): Promise<number> {
    if (bars.length === 0) return 0;

    let inserted = 0;
    const batchSize = 500;

    for (let i = 0; i < bars.length; i += batchSize) {
      const batch = bars.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      batch.forEach((bar, idx) => {
        const offset = idx * 11;
        placeholders.push(
          `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11})`,
        );
        values.push(
          bar.instrumentId,
          bar.timestamp,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.vwap,
          bar.trades,
          bar.barSize,
          bar.isAdjusted,
        );
      });

      const sql = `
        INSERT INTO ohlcv_bars (
          instrument_id, timestamp, open, high, low, close,
          volume, vwap, trades, bar_size, is_adjusted
        ) VALUES ${placeholders.join(',')}
        ON CONFLICT (instrument_id, timestamp, bar_size, is_adjusted) DO NOTHING
      `;

      const result = await this.pool.query(sql, values);
      inserted += result.rowCount;
    }

    logger.info('Inserted OHLCV bars', { count: inserted, total: bars.length });
    return inserted;
  }

  async getBars(params: {
    instrumentId: string;
    barSize: string;
    from: string;
    to: string;
    isAdjusted?: boolean;
    limit?: number;
  }): Promise<Record<string, unknown>[]> {
    const sql = `
      SELECT * FROM ohlcv_bars
      WHERE instrument_id = $1
        AND bar_size = $2
        AND timestamp >= $3
        AND timestamp <= $4
        AND is_adjusted = $5
      ORDER BY timestamp ASC
      LIMIT $6
    `;
    const result = await this.pool.query(sql, [
      params.instrumentId,
      params.barSize,
      params.from,
      params.to,
      params.isAdjusted ?? false,
      params.limit ?? 10000,
    ]);
    return result.rows;
  }

  // ─── Corporate Actions ───

  async insertCorporateAction(action: CorporateAction): Promise<void> {
    const sql = `
      INSERT INTO corporate_actions (
        id, instrument_id, type, ex_date, record_date, payment_date,
        ratio, amount, currency, description, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (instrument_id, type, ex_date, source) DO NOTHING
    `;
    await this.pool.query(sql, [
      action.id,
      action.instrumentId,
      action.type,
      action.exDate,
      action.recordDate,
      action.paymentDate,
      action.ratio,
      action.amount,
      action.currency,
      action.description,
      action.source,
    ]);
  }

  async getCorporateActions(
    instrumentId: string,
    from?: string,
    to?: string,
  ): Promise<Record<string, unknown>[]> {
    const conditions = ['instrument_id = $1'];
    const values: unknown[] = [instrumentId];

    if (from) {
      conditions.push(`ex_date >= $${values.length + 1}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`ex_date <= $${values.length + 1}`);
      values.push(to);
    }

    const sql = `
      SELECT * FROM corporate_actions
      WHERE ${conditions.join(' AND ')}
      ORDER BY ex_date DESC
    `;
    return (await this.pool.query(sql, values)).rows;
  }

  // ─── Fundamentals ───

  async upsertFundamentals(f: CompanyFundamentals): Promise<void> {
    const sql = `
      INSERT INTO company_fundamentals (
        instrument_id, report_date, period, fiscal_year, revenue,
        net_income, eps, eps_estimate, market_cap, pe_ratio,
        pb_ratio, debt_to_equity, dividend_yield, free_cash_flow,
        currency, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (instrument_id, report_date, period, source) DO UPDATE SET
        revenue = EXCLUDED.revenue,
        net_income = EXCLUDED.net_income,
        eps = EXCLUDED.eps,
        eps_estimate = EXCLUDED.eps_estimate,
        market_cap = EXCLUDED.market_cap,
        pe_ratio = EXCLUDED.pe_ratio,
        pb_ratio = EXCLUDED.pb_ratio,
        updated_at = NOW()
    `;
    await this.pool.query(sql, [
      f.instrumentId, f.reportDate, f.period, f.fiscalYear,
      f.revenue, f.netIncome, f.eps, f.epsEstimate,
      f.marketCap, f.peRatio, f.pbRatio, f.debtToEquity,
      f.dividendYield, f.freeCashFlow, f.currency, f.source,
    ]);
  }

  // ─── Earnings ───

  async upsertEarnings(e: EarningsEvent): Promise<void> {
    const sql = `
      INSERT INTO earnings_events (
        instrument_id, report_date, fiscal_quarter, eps_actual,
        eps_estimate, revenue_actual, revenue_estimate, surprise,
        transcript_url, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (instrument_id, report_date, source) DO UPDATE SET
        eps_actual = EXCLUDED.eps_actual,
        eps_estimate = EXCLUDED.eps_estimate,
        revenue_actual = EXCLUDED.revenue_actual,
        revenue_estimate = EXCLUDED.revenue_estimate,
        surprise = EXCLUDED.surprise
    `;
    await this.pool.query(sql, [
      e.instrumentId, e.reportDate, e.fiscalQuarter,
      e.epsActual, e.epsEstimate, e.revenueActual,
      e.revenueEstimate, e.surprise, e.transcriptUrl, e.source,
    ]);
  }

  async getUpcomingEarnings(
    from: string,
    to: string,
    limit: number = 100,
  ): Promise<Record<string, unknown>[]> {
    const sql = `
      SELECT e.*, i.primary_ticker, i.name
      FROM earnings_events e
      JOIN instruments i ON e.instrument_id = i.id
      WHERE e.report_date >= $1 AND e.report_date <= $2
      ORDER BY e.report_date ASC
      LIMIT $3
    `;
    return (await this.pool.query(sql, [from, to, limit])).rows;
  }

  // ─── Macro Events ───

  async upsertMacroEvent(event: MacroEvent): Promise<void> {
    const sql = `
      INSERT INTO macro_events (
        id, name, country, category, scheduled_at,
        actual, forecast, previous, unit, impact, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (name, scheduled_at, source) DO UPDATE SET
        actual = EXCLUDED.actual,
        forecast = EXCLUDED.forecast,
        previous = EXCLUDED.previous
    `;
    await this.pool.query(sql, [
      event.id, event.name, event.country, event.category,
      event.scheduledAt, event.actual, event.forecast,
      event.previous, event.unit, event.impact, event.source,
    ]);
  }

  async getMacroEvents(params: {
    from: string;
    to: string;
    country?: string;
    category?: string;
    impact?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const conditions = ['scheduled_at >= $1', 'scheduled_at <= $2'];
    const values: unknown[] = [params.from, params.to];
    let paramIdx = 3;

    if (params.country) {
      conditions.push(`country = $${paramIdx++}`);
      values.push(params.country);
    }
    if (params.category) {
      conditions.push(`category = $${paramIdx++}`);
      values.push(params.category);
    }
    if (params.impact) {
      conditions.push(`impact = $${paramIdx++}`);
      values.push(params.impact);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM macro_events ${where}`,
      values,
    );
    const total = parseInt(countResult.rows[0].total as string, 10);

    const sql = `
      SELECT * FROM macro_events ${where}
      ORDER BY scheduled_at ASC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataResult = await this.pool.query(sql, [...values, params.limit, params.offset]);

    return { rows: dataResult.rows, total };
  }

  // ─── News ───

  async insertNewsArticle(article: NewsArticle): Promise<void> {
    const sql = `
      INSERT INTO news_articles (
        id, title, summary, content, url, source,
        published_at, sentiment_score, sentiment_label, categories
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (url) DO NOTHING
    `;
    await this.pool.query(sql, [
      article.id, article.title, article.summary, article.content,
      article.url, article.source, article.publishedAt,
      article.sentimentScore, article.sentimentLabel, article.categories,
    ]);

    // Link to instruments
    for (const instrumentId of article.instrumentIds) {
      await this.pool.query(
        `INSERT INTO news_instruments (news_id, instrument_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [article.id, instrumentId],
      );
    }
  }

  async getNews(params: {
    from?: string;
    to?: string;
    sentiment?: string;
    instrumentId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;
    let join = '';

    if (params.instrumentId) {
      join = 'JOIN news_instruments ni ON n.id = ni.news_id';
      conditions.push(`ni.instrument_id = $${paramIdx++}`);
      values.push(params.instrumentId);
    }
    if (params.from) {
      conditions.push(`n.published_at >= $${paramIdx++}`);
      values.push(params.from);
    }
    if (params.to) {
      conditions.push(`n.published_at <= $${paramIdx++}`);
      values.push(params.to);
    }
    if (params.sentiment) {
      conditions.push(`n.sentiment_label = $${paramIdx++}`);
      values.push(params.sentiment);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM news_articles n ${join} ${where}`,
      values,
    );
    const total = parseInt(countResult.rows[0].total as string, 10);

    const sql = `
      SELECT n.* FROM news_articles n ${join} ${where}
      ORDER BY n.published_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const dataResult = await this.pool.query(sql, [...values, params.limit, params.offset]);

    return { rows: dataResult.rows, total };
  }
}
