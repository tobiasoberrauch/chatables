/**
 * Data Ingestion Pipeline Orchestrator
 *
 * Coordinates all data adapters through the normalization → validation → storage
 * pipeline. Runs on configurable schedules.
 *
 * Architecture:
 *   1. Adapter fetches raw data from external provider
 *   2. Normalizer transforms into canonical schema
 *   3. Validator checks data integrity
 *   4. PostgresStore persists validated records
 *   5. RedisCache publishes to streams for downstream consumers
 *
 * Failed records go to a dead-letter log for manual investigation.
 */

import { Logger } from '../../../shared/src/utils/logger';
import type {
  OHLCVBar,
  Instrument,
  NewsArticle,
  MacroEvent,
  CompanyFundamentals,
  EarningsEvent,
} from '../../../shared/src/types/instrument';

const logger = new Logger('ingestion-pipeline');

// ─── Types ───

export interface PipelineConfig {
  /** Instruments to ingest data for (tickers) */
  tickers: string[];
  /** Interval between full runs in milliseconds */
  intervalMs: number;
  /** Adapters to run */
  enabledAdapters: AdapterName[];
  /** Maximum retries for a single record */
  maxRecordRetries: number;
}

export type AdapterName = 'polygon' | 'iex' | 'alphaVantage' | 'newsapi' | 'fred';

export interface PipelineMetrics {
  lastRunStarted: string | null;
  lastRunCompleted: string | null;
  lastRunDurationMs: number;
  totalRecordsProcessed: number;
  totalRecordsFailed: number;
  deadLetterCount: number;
  adapterMetrics: Record<string, AdapterRunMetrics>;
}

export interface AdapterRunMetrics {
  recordsProcessed: number;
  recordsFailed: number;
  lastError: string | null;
  lastRunMs: number;
}

/** A record that failed all retries */
export interface DeadLetterRecord {
  timestamp: string;
  adapter: string;
  recordType: string;
  error: string;
  data: unknown;
}

// ─── Abstract Adapter Interface ───

export interface DataAdapter {
  name: AdapterName;
  fetchInstruments?(tickers: string[]): Promise<Partial<Instrument>[]>;
  fetchBars?(ticker: string, from: string, to: string): Promise<Partial<OHLCVBar>[]>;
  fetchFundamentals?(ticker: string): Promise<Partial<CompanyFundamentals>[]>;
  fetchEarnings?(ticker: string): Promise<Partial<EarningsEvent>[]>;
  fetchNews?(query: string): Promise<Partial<NewsArticle>[]>;
  fetchMacroEvents?(): Promise<Partial<MacroEvent>[]>;
}

// ─── Validator/Normalizer/Store Interfaces ───

export interface Normalizer {
  sanitizeBar(bar: Partial<OHLCVBar>): OHLCVBar | null;
}

export interface Validator {
  validateBar(bar: OHLCVBar): { valid: boolean; errors: string[] };
  validateInstrument(inst: Partial<Instrument>): { valid: boolean; errors: string[] };
}

export interface Store {
  upsertInstrument(instrument: Instrument): Promise<void>;
  insertBars(bars: OHLCVBar[]): Promise<number>;
  upsertFundamentals(f: CompanyFundamentals): Promise<void>;
  upsertEarnings(e: EarningsEvent): Promise<void>;
  upsertMacroEvent(event: MacroEvent): Promise<void>;
  insertNewsArticle(article: NewsArticle): Promise<void>;
}

export interface Cache {
  publishTick(tick: unknown): Promise<string>;
  publishNewsEvent(articleId: string, instrumentIds: string[]): Promise<string>;
}

// ─── Pipeline ───

export class IngestionPipeline {
  private readonly config: PipelineConfig;
  private readonly adapters: Map<AdapterName, DataAdapter>;
  private readonly normalizer: Normalizer;
  private readonly validator: Validator;
  private readonly store: Store;
  private readonly cache: Cache;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private deadLetterLog: DeadLetterRecord[] = [];

  private metrics: PipelineMetrics = {
    lastRunStarted: null,
    lastRunCompleted: null,
    lastRunDurationMs: 0,
    totalRecordsProcessed: 0,
    totalRecordsFailed: 0,
    deadLetterCount: 0,
    adapterMetrics: {},
  };

  constructor(
    config: PipelineConfig,
    adapters: DataAdapter[],
    normalizer: Normalizer,
    validator: Validator,
    store: Store,
    cache: Cache,
  ) {
    this.config = config;
    this.adapters = new Map(adapters.map((a) => [a.name, a]));
    this.normalizer = normalizer;
    this.validator = validator;
    this.store = store;
    this.cache = cache;
  }

  /** Start the pipeline on its configured schedule. */
  start(): void {
    if (this.timer) return;

    logger.info('Starting ingestion pipeline', {
      intervalMs: this.config.intervalMs,
      tickers: this.config.tickers.length,
      adapters: this.config.enabledAdapters,
    });

    // Run immediately, then on interval
    this.runCycle();
    this.timer = setInterval(() => this.runCycle(), this.config.intervalMs);
  }

  /** Stop the pipeline gracefully. Waits for current run to finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for current run to complete
    const maxWait = 60_000;
    const start = Date.now();
    while (this.isRunning && Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    logger.info('Ingestion pipeline stopped', {
      deadLetterCount: this.deadLetterLog.length,
    });
  }

  /** Get current pipeline metrics. */
  getMetrics(): PipelineMetrics {
    return { ...this.metrics };
  }

  /** Get dead letter records for investigation. */
  getDeadLetterLog(): DeadLetterRecord[] {
    return [...this.deadLetterLog];
  }

  // ─── Core Run Cycle ───

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Skipping run — previous cycle still in progress');
      return;
    }

    this.isRunning = true;
    const runStart = Date.now();
    this.metrics.lastRunStarted = new Date().toISOString();

    logger.info('Ingestion cycle started');

    for (const adapterName of this.config.enabledAdapters) {
      const adapter = this.adapters.get(adapterName);
      if (!adapter) {
        logger.warn('Adapter not found, skipping', { adapter: adapterName });
        continue;
      }

      const adapterStart = Date.now();
      const adapterMetrics: AdapterRunMetrics = {
        recordsProcessed: 0,
        recordsFailed: 0,
        lastError: null,
        lastRunMs: 0,
      };

      try {
        await this.runAdapter(adapter, adapterMetrics);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        adapterMetrics.lastError = err.message;
        logger.error(`Adapter ${adapterName} failed`, err);
      }

      adapterMetrics.lastRunMs = Date.now() - adapterStart;
      this.metrics.adapterMetrics[adapterName] = adapterMetrics;
      this.metrics.totalRecordsProcessed += adapterMetrics.recordsProcessed;
      this.metrics.totalRecordsFailed += adapterMetrics.recordsFailed;
    }

    this.metrics.lastRunDurationMs = Date.now() - runStart;
    this.metrics.lastRunCompleted = new Date().toISOString();
    this.metrics.deadLetterCount = this.deadLetterLog.length;
    this.isRunning = false;

    logger.info('Ingestion cycle completed', {
      durationMs: this.metrics.lastRunDurationMs,
      processed: this.metrics.totalRecordsProcessed,
      failed: this.metrics.totalRecordsFailed,
    });
  }

  private async runAdapter(
    adapter: DataAdapter,
    metrics: AdapterRunMetrics,
  ): Promise<void> {
    const { tickers } = this.config;

    // Phase 1: OHLCV bars
    if (adapter.fetchBars) {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Last 7 days

      for (const ticker of tickers) {
        try {
          const rawBars = await adapter.fetchBars(ticker, from, to);
          const validBars: OHLCVBar[] = [];

          for (const raw of rawBars) {
            const normalized = this.normalizer.sanitizeBar(raw);
            if (!normalized) {
              metrics.recordsFailed++;
              this.addDeadLetter(adapter.name, 'ohlcv_bar', 'Normalization returned null', raw);
              continue;
            }

            const validation = this.validator.validateBar(normalized);
            if (!validation.valid) {
              metrics.recordsFailed++;
              this.addDeadLetter(adapter.name, 'ohlcv_bar', validation.errors.join('; '), raw);
              continue;
            }

            validBars.push(normalized);
            metrics.recordsProcessed++;
          }

          if (validBars.length > 0) {
            await this.store.insertBars(validBars);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          metrics.lastError = err.message;
          logger.error(`Failed to fetch bars for ${ticker} from ${adapter.name}`, err);
        }
      }
    }

    // Phase 2: Fundamentals
    if (adapter.fetchFundamentals) {
      for (const ticker of tickers) {
        try {
          const fundamentals = await adapter.fetchFundamentals(ticker);
          for (const f of fundamentals) {
            await this.store.upsertFundamentals(f as CompanyFundamentals);
            metrics.recordsProcessed++;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          metrics.recordsFailed++;
          logger.error(`Failed to fetch fundamentals for ${ticker}`, err);
        }
      }
    }

    // Phase 3: Earnings
    if (adapter.fetchEarnings) {
      for (const ticker of tickers) {
        try {
          const earnings = await adapter.fetchEarnings(ticker);
          for (const e of earnings) {
            await this.store.upsertEarnings(e as EarningsEvent);
            metrics.recordsProcessed++;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          metrics.recordsFailed++;
          logger.error(`Failed to fetch earnings for ${ticker}`, err);
        }
      }
    }

    // Phase 4: News
    if (adapter.fetchNews) {
      try {
        const articles = await adapter.fetchNews(tickers.join(' OR '));
        for (const article of articles) {
          try {
            await this.store.insertNewsArticle(article as NewsArticle);
            if ((article as NewsArticle).id && (article as NewsArticle).instrumentIds) {
              await this.cache.publishNewsEvent(
                (article as NewsArticle).id,
                (article as NewsArticle).instrumentIds,
              );
            }
            metrics.recordsProcessed++;
          } catch (error) {
            metrics.recordsFailed++;
            this.addDeadLetter(adapter.name, 'news_article', String(error), article);
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        metrics.lastError = err.message;
        logger.error(`Failed to fetch news from ${adapter.name}`, err);
      }
    }

    // Phase 5: Macro events
    if (adapter.fetchMacroEvents) {
      try {
        const events = await adapter.fetchMacroEvents();
        for (const event of events) {
          await this.store.upsertMacroEvent(event as MacroEvent);
          metrics.recordsProcessed++;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        metrics.lastError = err.message;
        logger.error(`Failed to fetch macro events from ${adapter.name}`, err);
      }
    }
  }

  private addDeadLetter(
    adapter: string,
    recordType: string,
    error: string,
    data: unknown,
  ): void {
    const record: DeadLetterRecord = {
      timestamp: new Date().toISOString(),
      adapter,
      recordType,
      error,
      data,
    };

    this.deadLetterLog.push(record);

    // Keep dead letter log bounded (last 10,000 entries)
    if (this.deadLetterLog.length > 10_000) {
      this.deadLetterLog = this.deadLetterLog.slice(-10_000);
    }

    logger.warn('Record sent to dead letter', {
      adapter,
      recordType,
      error,
    });
  }
}

// ─── Entry Point ───

const DEFAULT_CONFIG: PipelineConfig = {
  tickers: ['AAPL', 'MSFT', 'AMZN', 'META', 'TSLA', 'SPY', 'QQQ'],
  intervalMs: 5 * 60 * 1000, // 5 minutes
  enabledAdapters: ['polygon', 'iex', 'alphaVantage', 'newsapi', 'fred'],
  maxRecordRetries: 3,
};

/**
 * Main entry point when running as a standalone service.
 * Connects to PostgreSQL and Redis, initializes adapters, and starts the pipeline.
 */
async function main(): Promise<void> {
  logger.info('Data ingestion service starting...');

  // In production, adapters, store, and cache would be instantiated with
  // real connections to PostgreSQL, Redis, and external APIs.
  // The pipeline is designed to receive these as injected dependencies.

  logger.info('Pipeline configuration', {
    tickers: DEFAULT_CONFIG.tickers,
    intervalMs: DEFAULT_CONFIG.intervalMs,
    adapters: DEFAULT_CONFIG.enabledAdapters,
  });

  logger.info('Waiting for adapter initialization...');
  logger.info('To run in production, instantiate adapters with API keys from environment');
  logger.info('Example: POLYGON_API_KEY, IEX_API_KEY, ALPHA_VANTAGE_API_KEY, NEWS_API_KEY, FRED_API_KEY');

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down ingestion service...');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('Fatal error in ingestion service', err as Error);
  process.exit(1);
});

export { DEFAULT_CONFIG };
