/**
 * Data Ingestion Pipeline -- Main Orchestrator
 *
 * Ties together:
 *   adapters (Polygon, IEX, Alpha Vantage, NewsAPI, FRED)
 *   -> normalization (ticker resolution, FX pair ordering, timestamps)
 *   -> validation (OHLCV integrity, anomaly detection)
 *   -> storage (Postgres via pg, with Redis for caching / streaming)
 *
 * Runs on a configurable cron schedule and handles:
 *   - Parallel ingestion across providers
 *   - Dead-letter queue for records that fail validation or storage
 *   - Health checks on all adapters before each run
 *   - Graceful shutdown
 *   - Structured logging of every stage
 */

import { CronJob } from 'cron';
import { Pool, PoolConfig } from 'pg';
import Redis from 'ioredis';

import { Logger } from '../../../shared/src/utils/logger';

// Adapters
import { PolygonAdapter, PolygonAdapterConfig } from './adapters/polygon-adapter';
import { IEXAdapter } from './adapters/iex-adapter';
import { AlphaVantageAdapter } from './adapters/alpha-vantage-adapter';
import { NewsAdapter } from './adapters/news-adapter';
import { FREDAdapter } from './adapters/fred-adapter';

// Normalization
import {
  InstrumentRegistry,
  normalizeBars,
  normalizeFxPair,
  adjustFxRate,
  sanitizeBar,
} from './normalization/normalizer';

// Validation
import {
  validateAndFilterBars,
  validateBatch,
  validateNewsArticle,
  validateMacroEvent,
  validateFundamentals,
  validateEarnings,
} from './validation/validator';

// Types
import {
  OHLCVBar,
  BarSize,
  Instrument,
  NewsArticle,
  MacroEvent,
  CompanyFundamentals,
  EarningsEvent,
} from '../../../shared/src/types/instrument';

const logger = new Logger('ingestion-pipeline');

// ===========================================================================
// Configuration
// ===========================================================================

export interface PipelineConfig {
  /** Cron expression for scheduled runs (default: every 15 minutes) */
  schedule: string;
  /** Timezone for cron (default: America/New_York) */
  timezone: string;

  /** Postgres connection config */
  postgres: PoolConfig;
  /** Redis connection URL */
  redisUrl: string;

  /** API keys for each provider */
  apiKeys: {
    polygon: string;
    iex: string;
    alphaVantage: string;
    newsapi: string;
    fred: string;
  };

  /** Tickers to ingest OHLCV bars for */
  watchlistTickers: string[];
  /** Enabled adapter names */
  enabledAdapters: AdapterName[];

  /** FX pairs to track, e.g. [['EUR','USD'], ['GBP','USD']] */
  fxPairs: [string, string][];

  /** FRED series IDs to ingest */
  fredSeriesIds: string[];

  /** Alpha Vantage macro indicators to ingest */
  macroIndicators: string[];

  /** Max records in the dead-letter queue before alerting */
  deadLetterAlertThreshold: number;

  /** Maximum retries for a single record */
  maxRecordRetries: number;

  /** Whether to run an immediate ingestion on startup */
  runOnStart: boolean;
}

export type AdapterName = 'polygon' | 'iex' | 'alphaVantage' | 'newsapi' | 'fred';

export interface PipelineMetrics {
  lastRunStarted: string | null;
  lastRunCompleted: string | null;
  lastRunDurationMs: number;
  totalRecordsProcessed: number;
  totalRecordsFailed: number;
  deadLetterCount: number;
  runCount: number;
  isRunning: boolean;
  adapterMetrics: Record<string, AdapterRunMetrics>;
}

export interface AdapterRunMetrics {
  recordsProcessed: number;
  recordsFailed: number;
  lastError: string | null;
  lastRunMs: number;
}

// ===========================================================================
// Dead-Letter Queue
// ===========================================================================

export interface DeadLetterRecord {
  id: string;
  recordType: 'bar' | 'tick' | 'news' | 'macro' | 'fundamentals' | 'earnings';
  record: unknown;
  error: string;
  failedAt: string;
  retryCount: number;
  source: string;
}

class DeadLetterQueue {
  private records: DeadLetterRecord[] = [];
  private readonly maxSize: number;
  private sequenceId = 0;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  push(
    recordType: DeadLetterRecord['recordType'],
    record: unknown,
    error: string,
    source: string,
  ): void {
    if (this.records.length >= this.maxSize) {
      this.records.shift();
      logger.warn('Dead-letter queue at capacity, evicting oldest record', {
        maxSize: this.maxSize,
      });
    }

    this.records.push({
      id: `dlq-${++this.sequenceId}`,
      recordType,
      record,
      error,
      failedAt: new Date().toISOString(),
      retryCount: 0,
      source,
    });

    logger.warn('Record sent to dead letter', { recordType, source, error });
  }

  drain(): DeadLetterRecord[] {
    const drained = [...this.records];
    this.records = [];
    return drained;
  }

  get size(): number {
    return this.records.length;
  }

  peek(limit: number = 10): DeadLetterRecord[] {
    return this.records.slice(0, limit);
  }
}

// ===========================================================================
// Pipeline
// ===========================================================================

const DEFAULT_CONFIG: PipelineConfig = {
  schedule: '*/15 * * * *',
  timezone: 'America/New_York',
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'chatables',
    user: process.env.POSTGRES_USER || 'chatables',
    password: process.env.POSTGRES_PASSWORD || '',
    max: 10,
    idleTimeoutMillis: 30000,
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  apiKeys: {
    polygon: process.env.POLYGON_API_KEY || '',
    iex: process.env.IEX_API_KEY || '',
    alphaVantage: process.env.ALPHA_VANTAGE_API_KEY || '',
    newsapi: process.env.NEWSAPI_API_KEY || '',
    fred: process.env.FRED_API_KEY || '',
  },
  watchlistTickers: (process.env.WATCHLIST_TICKERS || 'AAPL,MSFT,GOOGL,AMZN,TSLA,SPY,QQQ').split(','),
  enabledAdapters: ['polygon', 'iex', 'alphaVantage', 'newsapi', 'fred'],
  fxPairs: [['EUR', 'USD'], ['GBP', 'USD'], ['USD', 'JPY'], ['AUD', 'USD']],
  fredSeriesIds: ['DGS10', 'DGS2', 'FEDFUNDS', 'UNRATE', 'CPIAUCSL', 'T10Y2Y'],
  macroIndicators: ['REAL_GDP', 'CPI', 'UNEMPLOYMENT', 'FEDERAL_FUNDS_RATE'],
  deadLetterAlertThreshold: 100,
  maxRecordRetries: 3,
  runOnStart: false,
};

export class IngestionPipeline {
  private readonly config: PipelineConfig;

  // Infrastructure
  private pg!: Pool;
  private redis!: Redis;
  private cronJob: CronJob | null = null;

  // Adapters
  private polygonAdapter!: PolygonAdapter;
  private iexAdapter!: IEXAdapter;
  private alphaVantageAdapter!: AlphaVantageAdapter;
  private newsAdapter!: NewsAdapter;
  private fredAdapter!: FREDAdapter;

  // State
  private readonly instrumentRegistry = new InstrumentRegistry();
  private readonly deadLetterQueue = new DeadLetterQueue();
  private isRunning = false;
  private isShuttingDown = false;
  private runCount = 0;

  private metrics: PipelineMetrics = {
    lastRunStarted: null,
    lastRunCompleted: null,
    lastRunDurationMs: 0,
    totalRecordsProcessed: 0,
    totalRecordsFailed: 0,
    deadLetterCount: 0,
    runCount: 0,
    isRunning: false,
    adapterMetrics: {},
  };

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    logger.info('Starting ingestion pipeline', {
      schedule: this.config.schedule,
      tickers: this.config.watchlistTickers.length,
      fxPairs: this.config.fxPairs.length,
      adapters: this.config.enabledAdapters,
    });

    // Postgres
    this.pg = new Pool(this.config.postgres);
    this.pg.on('error', (err) => {
      logger.error('Postgres pool error', err);
    });
    await this.pg.query('SELECT 1');
    logger.info('Postgres connected');

    // Redis
    this.redis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    this.redis.on('error', (err) => {
      logger.error('Redis error', err as Error);
    });
    await this.redis.ping();
    logger.info('Redis connected');

    // Initialize adapters
    this.initAdapters();

    // Run health checks
    await this.runHealthChecks();

    // Cron schedule
    this.cronJob = new CronJob(
      this.config.schedule,
      () => this.runCycle(),
      null,
      true,
      this.config.timezone,
    );

    logger.info('Ingestion pipeline started', { schedule: this.config.schedule });

    // Graceful shutdown handlers
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    if (this.config.runOnStart) {
      this.runCycle().catch((err) => {
        logger.error('Initial ingestion cycle failed', err as Error);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.info('Shutting down ingestion pipeline');

    this.cronJob?.stop();

    // Wait for current run to complete
    const maxWait = 60_000;
    const start = Date.now();
    while (this.isRunning && Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Persist dead-letter records before shutdown
    await this.persistDeadLetterQueue();

    try {
      await this.pg?.end();
    } catch (err) {
      logger.error('Error closing Postgres', err as Error);
    }
    try {
      this.redis?.disconnect();
    } catch (err) {
      logger.error('Error closing Redis', err as Error);
    }

    logger.info('Ingestion pipeline shut down', {
      totalRuns: this.runCount,
      deadLetterCount: this.deadLetterQueue.size,
    });
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Adapter Initialization
  // -----------------------------------------------------------------------

  private initAdapters(): void {
    this.polygonAdapter = new PolygonAdapter({
      providerName: 'polygon',
      apiKey: this.config.apiKeys.polygon,
    } as PolygonAdapterConfig);

    this.iexAdapter = new IEXAdapter({
      providerName: 'iex',
      apiKey: this.config.apiKeys.iex,
    });

    this.alphaVantageAdapter = new AlphaVantageAdapter({
      providerName: 'alphaVantage',
      apiKey: this.config.apiKeys.alphaVantage,
    });

    this.newsAdapter = new NewsAdapter({
      providerName: 'newsapi',
      apiKey: this.config.apiKeys.newsapi,
    });

    this.fredAdapter = new FREDAdapter({
      providerName: 'fred',
      apiKey: this.config.apiKeys.fred,
    });

    logger.info('All adapters initialised');
  }

  // -----------------------------------------------------------------------
  // Health Checks
  // -----------------------------------------------------------------------

  private async runHealthChecks(): Promise<void> {
    const checks = [
      { name: 'polygon', adapter: this.polygonAdapter },
      { name: 'iex', adapter: this.iexAdapter },
      { name: 'alphaVantage', adapter: this.alphaVantageAdapter },
      { name: 'newsapi', adapter: this.newsAdapter },
      { name: 'fred', adapter: this.fredAdapter },
    ];

    const results = await Promise.allSettled(
      checks.map(async ({ name, adapter }) => {
        const result = await adapter.healthCheck();
        return { name, ...result };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { name, ok, latencyMs } = result.value;
        const logFn = ok ? 'info' : 'warn';
        logger[logFn](`Health check ${ok ? 'passed' : 'failed'}`, {
          adapter: name,
          latencyMs,
        });
      } else {
        logger.error('Health check threw', result.reason as Error);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Main Ingestion Cycle
  // -----------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Skipping run -- previous cycle still in progress');
      return;
    }

    this.isRunning = true;
    this.runCount++;
    const runStart = Date.now();
    const cycleId = `cycle-${this.runCount}-${Date.now()}`;

    this.metrics.lastRunStarted = new Date().toISOString();
    this.metrics.isRunning = true;
    this.metrics.runCount = this.runCount;

    logger.info('Ingestion cycle started', { cycleId, runCount: this.runCount });

    const adapterMetrics: Record<string, AdapterRunMetrics> = {};

    // Run all ingestion tasks in parallel
    const tasks: Array<{ name: string; fn: () => Promise<void> }> = [];

    if (this.config.enabledAdapters.includes('polygon')) {
      tasks.push({ name: 'equityBars', fn: () => this.ingestEquityBars(cycleId, adapterMetrics) });
    }
    if (this.config.enabledAdapters.includes('alphaVantage')) {
      tasks.push({ name: 'fxRates', fn: () => this.ingestFxRates(cycleId, adapterMetrics) });
    }
    if (this.config.enabledAdapters.includes('fred') || this.config.enabledAdapters.includes('alphaVantage')) {
      tasks.push({ name: 'macroData', fn: () => this.ingestMacroData(cycleId, adapterMetrics) });
    }
    if (this.config.enabledAdapters.includes('newsapi')) {
      tasks.push({ name: 'news', fn: () => this.ingestNews(cycleId, adapterMetrics) });
    }
    if (this.config.enabledAdapters.includes('iex')) {
      tasks.push({ name: 'fundamentals', fn: () => this.ingestFundamentals(cycleId, adapterMetrics) });
    }

    const results = await Promise.allSettled(tasks.map((t) => t.fn()));

    // Build summary
    const summary = {
      cycleId,
      durationMs: Date.now() - runStart,
      tasks: results.map((r, i) => ({
        task: tasks[i].name,
        status: r.status,
        error: r.status === 'rejected' ? (r.reason as Error).message : undefined,
      })),
      deadLetterQueueSize: this.deadLetterQueue.size,
    };

    // Update metrics
    this.metrics.lastRunDurationMs = Date.now() - runStart;
    this.metrics.lastRunCompleted = new Date().toISOString();
    this.metrics.deadLetterCount = this.deadLetterQueue.size;
    this.metrics.adapterMetrics = adapterMetrics;
    this.metrics.isRunning = false;
    this.isRunning = false;

    logger.info('Ingestion cycle complete', summary);

    // Alert on large DLQ
    if (this.deadLetterQueue.size >= this.config.deadLetterAlertThreshold) {
      logger.warn('Dead-letter queue threshold exceeded', {
        size: this.deadLetterQueue.size,
        threshold: this.config.deadLetterAlertThreshold,
      });
    }

    // Persist DLQ periodically
    if (this.runCount % 4 === 0) {
      await this.persistDeadLetterQueue();
    }
  }

  // -----------------------------------------------------------------------
  // Equity Bars
  // -----------------------------------------------------------------------

  private async ingestEquityBars(
    cycleId: string,
    adapterMetrics: Record<string, AdapterRunMetrics>,
  ): Promise<void> {
    const am: AdapterRunMetrics = { recordsProcessed: 0, recordsFailed: 0, lastError: null, lastRunMs: 0 };
    const start = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const from = this.daysAgo(7);

    for (const ticker of this.config.watchlistTickers) {
      try {
        const instrument = this.instrumentRegistry.resolveBySourceTicker('polygon', ticker);
        const instrumentId = instrument?.id || '';

        const rawBars = await this.polygonAdapter.fetchHistoricalBars(
          ticker, from, today, BarSize.DAY_1, true, instrumentId,
        );

        if (rawBars.length === 0) {
          logger.info('No new bars from Polygon', { ticker, from, to: today });
          continue;
        }

        // Normalize
        const normalized = normalizeBars(rawBars);

        // Sanitize
        const sanitized = normalized
          .map(sanitizeBar)
          .filter((b): b is OHLCVBar => b !== null);

        // Validate
        const { bars: validBars, summary } = validateAndFilterBars(sanitized);

        am.recordsProcessed += summary.accepted;
        am.recordsFailed += summary.rejected;

        logger.info('Equity bars processed', {
          cycleId, ticker,
          raw: rawBars.length,
          accepted: summary.accepted,
          rejected: summary.rejected,
        });

        // Dead-letter rejected bars
        if (summary.rejected > 0) {
          for (let i = 0; i < sanitized.length; i++) {
            if (!validBars.includes(sanitized[i])) {
              this.deadLetterQueue.push('bar', sanitized[i], 'Validation failed', 'polygon');
            }
          }
        }

        // Persist valid bars
        if (validBars.length > 0) {
          await this.storeBars(validBars);
        }
      } catch (err) {
        am.lastError = (err as Error).message;
        am.recordsFailed++;
        logger.error('Failed to ingest equity bars', err as Error, { cycleId, ticker });
        this.deadLetterQueue.push('bar', { ticker, from, to: today }, (err as Error).message, 'polygon');
      }
    }

    am.lastRunMs = Date.now() - start;
    adapterMetrics['polygon'] = am;
  }

  // -----------------------------------------------------------------------
  // FX Rates
  // -----------------------------------------------------------------------

  private async ingestFxRates(
    cycleId: string,
    adapterMetrics: Record<string, AdapterRunMetrics>,
  ): Promise<void> {
    const am: AdapterRunMetrics = { recordsProcessed: 0, recordsFailed: 0, lastError: null, lastRunMs: 0 };
    const start = Date.now();

    for (const [currA, currB] of this.config.fxPairs) {
      try {
        const normalized = normalizeFxPair(currA, currB);
        const rateData = await this.alphaVantageAdapter.fetchFxRate(normalized.base, normalized.quote);
        const rate = adjustFxRate(rateData.rate, normalized.wasInverted);

        // Cache in Redis
        const cacheKey = `fx:${normalized.pair}`;
        await this.redis.set(cacheKey, JSON.stringify({
          pair: normalized.pair,
          rate,
          bid: rateData.bidPrice,
          ask: rateData.askPrice,
          timestamp: rateData.timestamp,
        }), 'EX', 900);

        am.recordsProcessed++;
        logger.info('FX rate cached', { cycleId, pair: normalized.pair, rate });
      } catch (err) {
        am.lastError = (err as Error).message;
        am.recordsFailed++;
        logger.error('Failed to ingest FX rate', err as Error, { cycleId, pair: `${currA}/${currB}` });
        this.deadLetterQueue.push('bar', { currA, currB }, (err as Error).message, 'alphaVantage');
      }
    }

    am.lastRunMs = Date.now() - start;
    adapterMetrics['alphaVantage'] = { ...adapterMetrics['alphaVantage'] || am, ...am };
  }

  // -----------------------------------------------------------------------
  // Macro Data
  // -----------------------------------------------------------------------

  private async ingestMacroData(
    cycleId: string,
    adapterMetrics: Record<string, AdapterRunMetrics>,
  ): Promise<void> {
    const am: AdapterRunMetrics = { recordsProcessed: 0, recordsFailed: 0, lastError: null, lastRunMs: 0 };
    const start = Date.now();

    // FRED series
    if (this.config.enabledAdapters.includes('fred')) {
      for (const seriesId of this.config.fredSeriesIds) {
        try {
          const threeMonthsAgo = this.daysAgo(90);
          const events = await this.fredAdapter.fetchSeries(seriesId, threeMonthsAgo);
          const { records: validated, summary } = validateBatch(events, validateMacroEvent);
          const accepted = validated.filter((v) => v.accepted).map((v) => v.record);

          am.recordsProcessed += summary.accepted;
          am.recordsFailed += summary.rejected;

          if (accepted.length > 0) {
            await this.storeMacroEvents(accepted);
          }

          for (const v of validated.filter((v) => !v.accepted)) {
            this.deadLetterQueue.push('macro', v.record, 'Validation failed', 'fred');
          }

          logger.info('FRED series ingested', { cycleId, seriesId, accepted: summary.accepted });
        } catch (err) {
          am.lastError = (err as Error).message;
          am.recordsFailed++;
          logger.error('Failed to ingest FRED series', err as Error, { cycleId, seriesId });
          this.deadLetterQueue.push('macro', { seriesId }, (err as Error).message, 'fred');
        }
      }

      // FRED calendar
      try {
        const calendarEvents = await this.fredAdapter.fetchMacroCalendar(14);
        if (calendarEvents.length > 0) {
          await this.storeMacroEvents(calendarEvents);
          am.recordsProcessed += calendarEvents.length;
          logger.info('FRED macro calendar ingested', { cycleId, count: calendarEvents.length });
        }
      } catch (err) {
        logger.error('Failed to ingest FRED calendar', err as Error, { cycleId });
      }
    }

    // Alpha Vantage macro indicators
    if (this.config.enabledAdapters.includes('alphaVantage')) {
      for (const indicator of this.config.macroIndicators) {
        try {
          const events = await this.alphaVantageAdapter.fetchMacroindicator(indicator);
          const recent = events.slice(0, 12);
          const { records: validated, summary } = validateBatch(recent, validateMacroEvent);
          const accepted = validated.filter((v) => v.accepted).map((v) => v.record);

          am.recordsProcessed += summary.accepted;
          if (accepted.length > 0) await this.storeMacroEvents(accepted);

          logger.info('AV macro indicator ingested', { cycleId, indicator, accepted: summary.accepted });
        } catch (err) {
          am.lastError = (err as Error).message;
          am.recordsFailed++;
          logger.error('Failed to ingest AV macro', err as Error, { cycleId, indicator });
          this.deadLetterQueue.push('macro', { indicator }, (err as Error).message, 'alphaVantage');
        }
      }
    }

    am.lastRunMs = Date.now() - start;
    adapterMetrics['fred'] = am;
  }

  // -----------------------------------------------------------------------
  // News
  // -----------------------------------------------------------------------

  private async ingestNews(
    cycleId: string,
    adapterMetrics: Record<string, AdapterRunMetrics>,
  ): Promise<void> {
    const am: AdapterRunMetrics = { recordsProcessed: 0, recordsFailed: 0, lastError: null, lastRunMs: 0 };
    const start = Date.now();

    try {
      const headlines = await this.newsAdapter.fetchTopHeadlines('business', 'us', 50);
      const searchResults: NewsArticle[] = [];

      // Search for articles about a subset of our watchlist tickers
      const tickerQueries = this.config.watchlistTickers.slice(0, 5);
      for (const ticker of tickerQueries) {
        try {
          const articles = await this.newsAdapter.searchNews(ticker, this.daysAgo(1), undefined, 1, 20);
          searchResults.push(...articles);
        } catch (err) {
          logger.warn('News search failed for ticker', { ticker, error: (err as Error).message });
        }
      }

      const allArticles = [...headlines, ...searchResults];

      // Deduplicate by URL
      const seen = new Set<string>();
      const unique = allArticles.filter((a) => {
        if (seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });

      const { records: validated, summary } = validateBatch(unique, validateNewsArticle);
      const accepted = validated.filter((v) => v.accepted).map((v) => v.record);

      am.recordsProcessed += summary.accepted;
      am.recordsFailed += summary.rejected;

      if (accepted.length > 0) {
        await this.storeNewsArticles(accepted);
      }

      for (const v of validated.filter((v) => !v.accepted)) {
        this.deadLetterQueue.push('news', v.record, 'Validation failed', 'newsapi');
      }

      logger.info('News ingested', { cycleId, raw: allArticles.length, unique: unique.length, accepted: summary.accepted });
    } catch (err) {
      am.lastError = (err as Error).message;
      logger.error('Failed to ingest news', err as Error, { cycleId });
      this.deadLetterQueue.push('news', {}, (err as Error).message, 'newsapi');
    }

    am.lastRunMs = Date.now() - start;
    adapterMetrics['newsapi'] = am;
  }

  // -----------------------------------------------------------------------
  // Fundamentals & Earnings
  // -----------------------------------------------------------------------

  private async ingestFundamentals(
    cycleId: string,
    adapterMetrics: Record<string, AdapterRunMetrics>,
  ): Promise<void> {
    const am: AdapterRunMetrics = { recordsProcessed: 0, recordsFailed: 0, lastError: null, lastRunMs: 0 };
    const start = Date.now();

    // Rotate through tickers each cycle to spread load
    const batchSize = 3;
    const offset = ((this.runCount - 1) * batchSize) % this.config.watchlistTickers.length;
    const tickersThisCycle = this.config.watchlistTickers.slice(offset, offset + batchSize);

    for (const ticker of tickersThisCycle) {
      try {
        const instrument = this.instrumentRegistry.resolveBySourceTicker('iex', ticker);
        const instrumentId = instrument?.id || '';

        // Fundamentals
        const fundamentals = await this.iexAdapter.fetchCompanyFundamentals(ticker, instrumentId);
        const fundResult = validateFundamentals(fundamentals);
        if (fundResult.valid) {
          await this.storeFundamentals(fundamentals);
          am.recordsProcessed++;
        } else {
          am.recordsFailed++;
          logger.warn('Fundamentals validation failed', { ticker, issues: fundResult.issues.map((i) => i.code) });
          this.deadLetterQueue.push('fundamentals', fundamentals, 'Validation failed', 'iex');
        }

        // Earnings
        const earnings = await this.iexAdapter.fetchEarnings(ticker, instrumentId, 4);
        const { records: validatedEarnings, summary: earnSummary } = validateBatch(earnings, validateEarnings);
        const acceptedEarnings = validatedEarnings.filter((v) => v.accepted).map((v) => v.record);

        am.recordsProcessed += earnSummary.accepted;
        am.recordsFailed += earnSummary.rejected;

        if (acceptedEarnings.length > 0) {
          await this.storeEarnings(acceptedEarnings);
        }

        logger.info('Fundamentals/earnings ingested', { cycleId, ticker, fundValid: fundResult.valid, earnings: earnSummary.accepted });
      } catch (err) {
        am.lastError = (err as Error).message;
        am.recordsFailed++;
        logger.error('Failed to ingest fundamentals', err as Error, { cycleId, ticker });
        this.deadLetterQueue.push('fundamentals', { ticker }, (err as Error).message, 'iex');
      }
    }

    am.lastRunMs = Date.now() - start;
    adapterMetrics['iex'] = am;
  }

  // -----------------------------------------------------------------------
  // Storage Layer
  // -----------------------------------------------------------------------

  private async storeBars(bars: OHLCVBar[]): Promise<void> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO ohlcv_bars (
          instrument_id, timestamp, open, high, low, close,
          volume, vwap, trades, bar_size, is_adjusted, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (instrument_id, timestamp, bar_size)
        DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high,
          low = EXCLUDED.low, close = EXCLUDED.close,
          volume = EXCLUDED.volume, vwap = EXCLUDED.vwap,
          trades = EXCLUDED.trades, is_adjusted = EXCLUDED.is_adjusted,
          source = EXCLUDED.source, updated_at = NOW()
      `;
      for (const bar of bars) {
        await client.query(query, [
          bar.instrumentId, bar.timestamp, bar.open, bar.high,
          bar.low, bar.close, bar.volume, bar.vwap,
          bar.trades, bar.barSize, bar.isAdjusted, bar.source,
        ]);
      }
      await client.query('COMMIT');
      this.metrics.totalRecordsProcessed += bars.length;
      logger.debug('Stored bars', { count: bars.length });
    } catch (err) {
      await client.query('ROLLBACK');
      this.metrics.totalRecordsFailed += bars.length;
      logger.error('Failed to store bars', err as Error, { count: bars.length });
      for (const bar of bars) {
        this.deadLetterQueue.push('bar', bar, (err as Error).message, bar.source);
      }
    } finally {
      client.release();
    }
  }

  private async storeMacroEvents(events: MacroEvent[]): Promise<void> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO macro_events (
          id, name, country, category, scheduled_at,
          actual, forecast, previous, unit, impact, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id)
        DO UPDATE SET
          actual = COALESCE(EXCLUDED.actual, macro_events.actual),
          forecast = COALESCE(EXCLUDED.forecast, macro_events.forecast),
          previous = COALESCE(EXCLUDED.previous, macro_events.previous),
          updated_at = NOW()
      `;
      for (const event of events) {
        await client.query(query, [
          event.id, event.name, event.country, event.category,
          event.scheduledAt, event.actual, event.forecast,
          event.previous, event.unit, event.impact, event.source,
        ]);
      }
      await client.query('COMMIT');
      logger.debug('Stored macro events', { count: events.length });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to store macro events', err as Error);
      for (const ev of events) {
        this.deadLetterQueue.push('macro', ev, (err as Error).message, ev.source);
      }
    } finally {
      client.release();
    }
  }

  private async storeNewsArticles(articles: NewsArticle[]): Promise<void> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO news_articles (
          id, title, summary, content, url, source,
          published_at, instrument_ids, tickers,
          sentiment_score, sentiment_label, categories
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (url)
        DO UPDATE SET
          sentiment_score = COALESCE(EXCLUDED.sentiment_score, news_articles.sentiment_score),
          instrument_ids = EXCLUDED.instrument_ids, updated_at = NOW()
      `;
      for (const article of articles) {
        await client.query(query, [
          article.id, article.title, article.summary, article.content,
          article.url, article.source, article.publishedAt,
          JSON.stringify(article.instrumentIds), JSON.stringify(article.tickers),
          article.sentimentScore, article.sentimentLabel, JSON.stringify(article.categories),
        ]);
      }
      await client.query('COMMIT');

      // Publish to Redis stream for real-time subscribers
      for (const article of articles) {
        await this.redis.xadd('stream:news', '*',
          'id', article.id,
          'title', article.title,
          'source', article.source,
          'tickers', JSON.stringify(article.tickers),
        );
      }

      logger.debug('Stored news articles', { count: articles.length });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to store news articles', err as Error);
      for (const a of articles) {
        this.deadLetterQueue.push('news', a, (err as Error).message, 'newsapi');
      }
    } finally {
      client.release();
    }
  }

  private async storeFundamentals(f: CompanyFundamentals): Promise<void> {
    try {
      const query = `
        INSERT INTO company_fundamentals (
          instrument_id, report_date, period, fiscal_year,
          revenue, net_income, eps, eps_estimate,
          market_cap, pe_ratio, pb_ratio, debt_to_equity,
          dividend_yield, free_cash_flow, currency, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (instrument_id, report_date, period)
        DO UPDATE SET
          revenue = COALESCE(EXCLUDED.revenue, company_fundamentals.revenue),
          net_income = COALESCE(EXCLUDED.net_income, company_fundamentals.net_income),
          market_cap = EXCLUDED.market_cap, pe_ratio = EXCLUDED.pe_ratio, updated_at = NOW()
      `;
      await this.pg.query(query, [
        f.instrumentId, f.reportDate, f.period, f.fiscalYear,
        f.revenue, f.netIncome, f.eps, f.epsEstimate,
        f.marketCap, f.peRatio, f.pbRatio, f.debtToEquity,
        f.dividendYield, f.freeCashFlow, f.currency, f.source,
      ]);
    } catch (err) {
      logger.error('Failed to store fundamentals', err as Error);
      this.deadLetterQueue.push('fundamentals', f, (err as Error).message, f.source);
    }
  }

  private async storeEarnings(earnings: EarningsEvent[]): Promise<void> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO earnings_events (
          instrument_id, report_date, fiscal_quarter,
          eps_actual, eps_estimate, revenue_actual, revenue_estimate,
          surprise, transcript_url, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (instrument_id, report_date)
        DO UPDATE SET
          eps_actual = COALESCE(EXCLUDED.eps_actual, earnings_events.eps_actual),
          revenue_actual = COALESCE(EXCLUDED.revenue_actual, earnings_events.revenue_actual),
          surprise = COALESCE(EXCLUDED.surprise, earnings_events.surprise),
          updated_at = NOW()
      `;
      for (const e of earnings) {
        await client.query(query, [
          e.instrumentId, e.reportDate, e.fiscalQuarter,
          e.epsActual, e.epsEstimate, e.revenueActual, e.revenueEstimate,
          e.surprise, e.transcriptUrl, e.source,
        ]);
      }
      await client.query('COMMIT');
      logger.debug('Stored earnings', { count: earnings.length });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to store earnings', err as Error);
      for (const e of earnings) {
        this.deadLetterQueue.push('earnings', e, (err as Error).message, e.source);
      }
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // Dead-Letter Queue Persistence
  // -----------------------------------------------------------------------

  private async persistDeadLetterQueue(): Promise<void> {
    const records = this.deadLetterQueue.drain();
    if (records.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      for (const record of records) {
        pipeline.rpush('dlq:ingestion', JSON.stringify(record));
      }
      pipeline.ltrim('dlq:ingestion', -10000, -1);
      await pipeline.exec();
      logger.info('Dead-letter queue persisted to Redis', { count: records.length });
    } catch (err) {
      logger.error('Failed to persist DLQ to Redis', err as Error, { count: records.length });
      // Re-queue records
      for (const record of records) {
        this.deadLetterQueue.push(record.recordType, record.record, record.error, record.source);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers & Public API
  // -----------------------------------------------------------------------

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  getMetrics(): PipelineMetrics {
    return { ...this.metrics, deadLetterCount: this.deadLetterQueue.size };
  }

  getDeadLetterLog(): DeadLetterRecord[] {
    return this.deadLetterQueue.peek(100);
  }

  getInstrumentRegistry(): InstrumentRegistry {
    return this.instrumentRegistry;
  }
}

// ===========================================================================
// Entry Point
// ===========================================================================

async function main(): Promise<void> {
  logger.info('Data ingestion service starting');

  const pipeline = new IngestionPipeline({
    runOnStart: process.env.RUN_ON_START === 'true',
    schedule: process.env.INGESTION_SCHEDULE || '*/15 * * * *',
  });

  try {
    await pipeline.start();
  } catch (err) {
    logger.error('Failed to start ingestion pipeline', err as Error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error in ingestion service', err as Error);
    process.exit(1);
  });
}

export { DEFAULT_CONFIG };
export default IngestionPipeline;
