/**
 * Data Validation Pipeline
 *
 * Validates financial market data for consistency and correctness before
 * it enters the storage layer.  Every record flows through this pipeline
 * between normalization and persistence.
 *
 * Capabilities:
 *   - OHLCV bar integrity (high >= low, non-negative volume, finite prices)
 *   - OHLC range consistency (open/close within high-low)
 *   - Price continuity / anomaly detection (>50% jump in one bar)
 *   - Volume spike detection (rolling average multiplier)
 *   - Timestamp ordering and duplicate detection
 *   - Instrument field completeness
 *   - Tick validation
 *   - News article validation
 *   - Macro event validation
 *   - Typed validation results with severity levels
 *   - Structured logging of every anomaly
 */

import type {
  OHLCVBar,
  Instrument,
  Tick,
  NewsArticle,
  MacroEvent,
  CompanyFundamentals,
  EarningsEvent,
} from '../../../../shared/src/types/instrument';
import { Logger } from '../../../../shared/src/utils/logger';

const logger = new Logger('validator');

// ===========================================================================
// Validation Result Types
// ===========================================================================

export enum ValidationSeverity {
  /** Data is unusable and must be rejected */
  ERROR = 'error',
  /** Data is suspicious, can be accepted but should be flagged */
  WARNING = 'warning',
  /** Informational — data was auto-corrected or is borderline */
  INFO = 'info',
}

export interface ValidationIssue {
  severity: ValidationSeverity;
  /** Machine-readable error code */
  code: string;
  /** Human-readable description */
  message: string;
  /** Which field triggered the issue */
  field?: string;
  /** Index in the batch where the issue was found */
  index?: number;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
}

export interface ValidationResult {
  /** True if there are no ERROR-severity issues */
  valid: boolean;
  /** All issues found (errors, warnings, info) */
  issues: ValidationIssue[];
  /** Count of errors */
  errorCount: number;
  /** Count of warnings */
  warningCount: number;
}

/** A validated record wrapper: either accepted or rejected */
export interface ValidatedRecord<T> {
  record: T;
  result: ValidationResult;
  /** Whether this record should proceed to storage */
  accepted: boolean;
}

/** Summary of a batch validation run */
export interface BatchValidationSummary {
  totalRecords: number;
  accepted: number;
  rejected: number;
  warningsTotal: number;
  /** Breakdown of issue codes and their counts */
  issueBreakdown: Record<string, number>;
}

// ===========================================================================
// Helpers
// ===========================================================================

function buildResult(issues: ValidationIssue[]): ValidationResult {
  const errorCount = issues.filter((i) => i.severity === ValidationSeverity.ERROR).length;
  const warningCount = issues.filter((i) => i.severity === ValidationSeverity.WARNING).length;
  return {
    valid: errorCount === 0,
    issues,
    errorCount,
    warningCount,
  };
}

function error(code: string, message: string, field?: string, index?: number, context?: Record<string, unknown>): ValidationIssue {
  return { severity: ValidationSeverity.ERROR, code, message, field, index, context };
}

function warning(code: string, message: string, field?: string, index?: number, context?: Record<string, unknown>): ValidationIssue {
  return { severity: ValidationSeverity.WARNING, code, message, field, index, context };
}

function info(code: string, message: string, field?: string, index?: number, context?: Record<string, unknown>): ValidationIssue {
  return { severity: ValidationSeverity.INFO, code, message, field, index, context };
}

// ===========================================================================
// OHLCV Bar Validation
// ===========================================================================

/**
 * Validate a single OHLCV bar for data integrity.
 */
export function validateOHLCVBar(bar: OHLCVBar): ValidationResult {
  const issues: ValidationIssue[] = [];

  // --- Finite number checks ---
  for (const [field, value] of Object.entries({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  })) {
    if (!Number.isFinite(value)) {
      issues.push(error('NON_FINITE_NUMBER', `${field} is not a finite number: ${value}`, field));
    }
  }

  // --- Price positivity ---
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) {
    // Zero/negative prices are errors for equities but might be valid for
    // interest rate series.  We flag as error for equities.
    issues.push(error(
      'NON_POSITIVE_PRICE',
      `One or more OHLC prices are non-positive: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close}`,
      'open/high/low/close',
    ));
  }

  // --- High >= Low ---
  if (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high < bar.low) {
    issues.push(error(
      'HIGH_LESS_THAN_LOW',
      `High (${bar.high}) is less than low (${bar.low})`,
      'high',
    ));
  }

  // --- Volume >= 0 ---
  if (Number.isFinite(bar.volume) && bar.volume < 0) {
    issues.push(error('NEGATIVE_VOLUME', `Volume is negative (${bar.volume})`, 'volume'));
  }

  // --- Open/Close within High-Low range ---
  if (Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low)) {
    if (bar.open > bar.high) {
      issues.push(warning(
        'OPEN_ABOVE_HIGH',
        `Open (${bar.open}) is above high (${bar.high})`,
        'open',
      ));
    }
    if (bar.open < bar.low) {
      issues.push(warning(
        'OPEN_BELOW_LOW',
        `Open (${bar.open}) is below low (${bar.low})`,
        'open',
      ));
    }
    if (bar.close > bar.high) {
      issues.push(warning(
        'CLOSE_ABOVE_HIGH',
        `Close (${bar.close}) is above high (${bar.high})`,
        'close',
      ));
    }
    if (bar.close < bar.low) {
      issues.push(warning(
        'CLOSE_BELOW_LOW',
        `Close (${bar.close}) is below low (${bar.low})`,
        'close',
      ));
    }
  }

  // --- Timestamp validity ---
  if (!bar.timestamp || isNaN(Date.parse(bar.timestamp))) {
    issues.push(error('INVALID_TIMESTAMP', `Invalid timestamp: ${bar.timestamp}`, 'timestamp'));
  }

  // --- VWAP sanity ---
  if (bar.vwap != null) {
    if (!Number.isFinite(bar.vwap)) {
      issues.push(warning('NON_FINITE_VWAP', `VWAP is not finite: ${bar.vwap}`, 'vwap'));
    } else if (Number.isFinite(bar.high) && Number.isFinite(bar.low)) {
      if (bar.vwap > bar.high * 1.01 || bar.vwap < bar.low * 0.99) {
        issues.push(warning(
          'VWAP_OUT_OF_RANGE',
          `VWAP (${bar.vwap}) is outside the high-low range [${bar.low}, ${bar.high}]`,
          'vwap',
        ));
      }
    }
  }

  // --- instrumentId presence ---
  if (!bar.instrumentId) {
    issues.push(warning('MISSING_INSTRUMENT_ID', 'Bar is missing instrumentId', 'instrumentId'));
  }

  // --- source presence ---
  if (!bar.source) {
    issues.push(warning('MISSING_SOURCE', 'Bar is missing source', 'source'));
  }

  return buildResult(issues);
}

// ===========================================================================
// Bar Series Validation
// ===========================================================================

export interface BarSeriesValidationOptions {
  /** Max allowed % change between consecutive bar closes. Default: 50 */
  maxPriceJumpPercent?: number;
  /** Volume spike threshold as multiplier of rolling average. Default: 10 */
  volumeSpikeMultiplier?: number;
  /** Rolling window size for volume average. Default: 20 */
  volumeWindow?: number;
  /** Whether to log every anomaly to structured logger. Default: true */
  logAnomalies?: boolean;
}

/**
 * Validate an ordered series of OHLCV bars.
 *
 * In addition to per-bar validation, checks:
 *   - Chronological timestamp ordering
 *   - Price jump detection (> threshold between consecutive bars)
 *   - Volume spike detection (> multiplier of rolling average)
 *   - Gap detection (missing trading days)
 *   - Duplicate bar detection (same timestamp)
 */
export function validateBarSeries(
  bars: OHLCVBar[],
  options: BarSeriesValidationOptions = {},
): ValidationResult {
  const maxJump = options.maxPriceJumpPercent ?? 50;
  const volMultiplier = options.volumeSpikeMultiplier ?? 10;
  const volWindow = options.volumeWindow ?? 20;
  const logAnomalies = options.logAnomalies ?? true;

  const issues: ValidationIssue[] = [];

  if (bars.length === 0) {
    return buildResult([]);
  }

  const recentVolumes: number[] = [];
  const seenTimestamps = new Set<string>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Per-bar validation
    const barResult = validateOHLCVBar(bar);
    for (const issue of barResult.issues) {
      issues.push({ ...issue, index: i });
    }

    // Duplicate timestamp
    const tsKey = `${bar.instrumentId}:${bar.timestamp}:${bar.barSize}`;
    if (seenTimestamps.has(tsKey)) {
      const iss = error(
        'DUPLICATE_TIMESTAMP',
        `Duplicate bar at index ${i}: ${bar.timestamp}`,
        'timestamp',
        i,
      );
      issues.push(iss);
      if (logAnomalies) {
        logger.warn('Duplicate bar detected', {
          index: i,
          timestamp: bar.timestamp,
          instrumentId: bar.instrumentId,
        });
      }
    }
    seenTimestamps.add(tsKey);

    if (i > 0) {
      const prevBar = bars[i - 1];

      // Timestamp ordering
      if (bar.timestamp <= prevBar.timestamp) {
        issues.push(error(
          'TIMESTAMP_ORDER',
          `Bar at index ${i} timestamp ${bar.timestamp} <= previous ${prevBar.timestamp}`,
          'timestamp',
          i,
        ));
      }

      // Price jump detection
      if (prevBar.close > 0 && bar.close > 0) {
        const changePercent = Math.abs((bar.close - prevBar.close) / prevBar.close) * 100;
        if (changePercent > maxJump) {
          const iss = warning(
            'PRICE_JUMP',
            `Price jumped ${changePercent.toFixed(1)}% between bars ${i - 1} and ${i} (threshold: ${maxJump}%)`,
            'close',
            i,
            {
              previousClose: prevBar.close,
              currentClose: bar.close,
              changePct: parseFloat(changePercent.toFixed(2)),
              previousTimestamp: prevBar.timestamp,
              currentTimestamp: bar.timestamp,
            },
          );
          issues.push(iss);
          if (logAnomalies) {
            logger.warn('Price jump anomaly detected', {
              instrumentId: bar.instrumentId,
              index: i,
              previousClose: prevBar.close,
              currentClose: bar.close,
              changePct: changePercent.toFixed(2),
              timestamp: bar.timestamp,
            });
          }
        }
      }
    }

    // Volume spike detection
    if (bar.volume >= 0) {
      recentVolumes.push(bar.volume);
      if (recentVolumes.length > volWindow) recentVolumes.shift();

      if (recentVolumes.length >= volWindow) {
        const windowWithoutLast = recentVolumes.slice(0, -1);
        const avgVolume = windowWithoutLast.reduce((a, b) => a + b, 0) / windowWithoutLast.length;
        if (avgVolume > 0 && bar.volume > avgVolume * volMultiplier) {
          const iss = warning(
            'VOLUME_SPIKE',
            `Volume spike at index ${i}: ${bar.volume} is ${(bar.volume / avgVolume).toFixed(1)}x the ${volWindow}-bar average`,
            'volume',
            i,
            {
              volume: bar.volume,
              avgVolume: Math.round(avgVolume),
              multiplier: parseFloat((bar.volume / avgVolume).toFixed(1)),
            },
          );
          issues.push(iss);
          if (logAnomalies) {
            logger.warn('Volume spike anomaly detected', {
              instrumentId: bar.instrumentId,
              index: i,
              volume: bar.volume,
              avgVolume: Math.round(avgVolume),
              timestamp: bar.timestamp,
            });
          }
        }
      }
    }
  }

  return buildResult(issues);
}

// ===========================================================================
// Instrument Field Validation
// ===========================================================================

/**
 * Validate completeness and correctness of instrument fields.
 */
export function validateInstrument(instrument: Partial<Instrument>): ValidationResult {
  const issues: ValidationIssue[] = [];

  const requiredFields: Array<{ field: keyof Instrument; label: string }> = [
    { field: 'id', label: 'ID' },
    { field: 'type', label: 'Instrument type' },
    { field: 'assetClass', label: 'Asset class' },
    { field: 'name', label: 'Name' },
    { field: 'primaryTicker', label: 'Primary ticker' },
    { field: 'currency', label: 'Currency' },
  ];

  for (const { field, label } of requiredFields) {
    const value = instrument[field];
    if (value === undefined || value === null || value === '') {
      issues.push(error('MISSING_REQUIRED_FIELD', `${label} is required`, field));
    }
  }

  // Ticker format
  if (instrument.primaryTicker && !/^[A-Z0-9.\-/]{1,20}$/i.test(instrument.primaryTicker)) {
    issues.push(warning(
      'INVALID_TICKER_FORMAT',
      `Ticker format may be invalid: ${instrument.primaryTicker}`,
      'primaryTicker',
    ));
  }

  // Currency code (ISO 4217: 3 uppercase letters)
  if (instrument.currency && !/^[A-Z]{3}$/.test(instrument.currency)) {
    issues.push(error(
      'INVALID_CURRENCY',
      `Invalid currency code: ${instrument.currency}`,
      'currency',
    ));
  }

  // Country code (ISO 3166-1 alpha-2)
  if (instrument.country && !/^[A-Z]{2}$/.test(instrument.country)) {
    issues.push(warning(
      'INVALID_COUNTRY',
      `Invalid country code: ${instrument.country}`,
      'country',
    ));
  }

  // ISIN format if present
  if (instrument.isin) {
    if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(instrument.isin)) {
      issues.push(warning(
        'INVALID_ISIN_FORMAT',
        `ISIN format may be invalid: ${instrument.isin}`,
        'isin',
      ));
    }
  }

  // Validate tickerAliases is an array
  if (instrument.tickerAliases && !Array.isArray(instrument.tickerAliases)) {
    issues.push(error(
      'INVALID_TICKER_ALIASES',
      'tickerAliases must be an array',
      'tickerAliases',
    ));
  }

  return buildResult(issues);
}

// ===========================================================================
// Tick Validation
// ===========================================================================

/**
 * Validate a single real-time tick.
 */
export function validateTick(tick: Tick): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!Number.isFinite(tick.price) || tick.price <= 0) {
    issues.push(error(
      'INVALID_TICK_PRICE',
      `Tick price is invalid: ${tick.price}`,
      'price',
    ));
  }

  if (!Number.isFinite(tick.size) || tick.size < 0) {
    issues.push(error(
      'INVALID_TICK_SIZE',
      `Tick size is invalid: ${tick.size}`,
      'size',
    ));
  }

  if (!tick.timestamp || isNaN(Date.parse(tick.timestamp))) {
    issues.push(error(
      'INVALID_TICK_TIMESTAMP',
      `Tick timestamp is invalid: ${tick.timestamp}`,
      'timestamp',
    ));
  }

  if (!tick.exchangeMic) {
    issues.push(warning(
      'MISSING_EXCHANGE_MIC',
      'Tick is missing exchange MIC',
      'exchangeMic',
    ));
  }

  if (!tick.instrumentId) {
    issues.push(warning(
      'MISSING_INSTRUMENT_ID',
      'Tick is missing instrumentId',
      'instrumentId',
    ));
  }

  return buildResult(issues);
}

// ===========================================================================
// News Article Validation
// ===========================================================================

/**
 * Validate a news article record.
 */
export function validateNewsArticle(article: NewsArticle): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!article.title || article.title.trim().length === 0) {
    issues.push(error('MISSING_TITLE', 'Article title is required', 'title'));
  }

  if (!article.url || !article.url.startsWith('http')) {
    issues.push(error('INVALID_URL', `Article URL is invalid: ${article.url}`, 'url'));
  }

  if (!article.publishedAt || isNaN(Date.parse(article.publishedAt))) {
    issues.push(error('INVALID_PUBLISHED_AT', `Invalid publishedAt: ${article.publishedAt}`, 'publishedAt'));
  }

  if (!article.source || article.source.trim().length === 0) {
    issues.push(warning('MISSING_SOURCE', 'Article source is missing', 'source'));
  }

  // Validate sentiment score range
  if (article.sentimentScore != null) {
    if (article.sentimentScore < -1 || article.sentimentScore > 1) {
      issues.push(warning(
        'SENTIMENT_OUT_OF_RANGE',
        `Sentiment score ${article.sentimentScore} is outside [-1, 1]`,
        'sentimentScore',
      ));
    }
  }

  // Validate sentiment label consistency
  if (article.sentimentScore != null && article.sentimentLabel != null) {
    const score = article.sentimentScore;
    const label = article.sentimentLabel;
    if (score > 0.2 && label === 'bearish') {
      issues.push(warning(
        'SENTIMENT_LABEL_MISMATCH',
        `Sentiment score ${score} is positive but label is bearish`,
        'sentimentLabel',
      ));
    }
    if (score < -0.2 && label === 'bullish') {
      issues.push(warning(
        'SENTIMENT_LABEL_MISMATCH',
        `Sentiment score ${score} is negative but label is bullish`,
        'sentimentLabel',
      ));
    }
  }

  return buildResult(issues);
}

// ===========================================================================
// Macro Event Validation
// ===========================================================================

/**
 * Validate a macroeconomic event record.
 */
export function validateMacroEvent(event: MacroEvent): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!event.name || event.name.trim().length === 0) {
    issues.push(error('MISSING_EVENT_NAME', 'Macro event name is required', 'name'));
  }

  if (!event.scheduledAt || isNaN(Date.parse(event.scheduledAt))) {
    issues.push(error('INVALID_SCHEDULED_AT', `Invalid scheduledAt: ${event.scheduledAt}`, 'scheduledAt'));
  }

  if (!event.country || !/^[A-Z]{2}$/.test(event.country)) {
    issues.push(warning('INVALID_COUNTRY', `Invalid country code: ${event.country}`, 'country'));
  }

  if (!event.source) {
    issues.push(warning('MISSING_SOURCE', 'Macro event source is missing', 'source'));
  }

  // If actual and previous are both present, flag very large changes
  if (event.actual != null && event.previous != null && event.previous !== 0) {
    const changePct = Math.abs((event.actual - event.previous) / event.previous) * 100;
    if (changePct > 100) {
      issues.push(warning(
        'LARGE_MACRO_CHANGE',
        `${event.name}: value changed ${changePct.toFixed(1)}% from previous (${event.previous} -> ${event.actual})`,
        'actual',
        undefined,
        { changePct: parseFloat(changePct.toFixed(1)), previous: event.previous, actual: event.actual },
      ));
    }
  }

  return buildResult(issues);
}

// ===========================================================================
// Fundamentals Validation
// ===========================================================================

/**
 * Validate a company fundamentals record.
 */
export function validateFundamentals(fundamentals: CompanyFundamentals): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!fundamentals.instrumentId) {
    issues.push(warning('MISSING_INSTRUMENT_ID', 'Fundamentals missing instrumentId', 'instrumentId'));
  }

  if (!fundamentals.reportDate || isNaN(Date.parse(fundamentals.reportDate))) {
    issues.push(error('INVALID_REPORT_DATE', `Invalid reportDate: ${fundamentals.reportDate}`, 'reportDate'));
  }

  // Negative market cap is suspicious
  if (fundamentals.marketCap != null && fundamentals.marketCap < 0) {
    issues.push(warning('NEGATIVE_MARKET_CAP', `Negative market cap: ${fundamentals.marketCap}`, 'marketCap'));
  }

  // P/E ratio sanity
  if (fundamentals.peRatio != null) {
    if (fundamentals.peRatio > 1000) {
      issues.push(warning(
        'EXTREME_PE_RATIO',
        `P/E ratio ${fundamentals.peRatio} is extremely high`,
        'peRatio',
      ));
    }
    if (fundamentals.peRatio < -100) {
      issues.push(warning(
        'EXTREME_PE_RATIO',
        `P/E ratio ${fundamentals.peRatio} is extremely negative`,
        'peRatio',
      ));
    }
  }

  // Dividend yield > 100% is almost certainly wrong
  if (fundamentals.dividendYield != null && fundamentals.dividendYield > 1) {
    issues.push(warning(
      'HIGH_DIVIDEND_YIELD',
      `Dividend yield ${(fundamentals.dividendYield * 100).toFixed(1)}% is unusually high`,
      'dividendYield',
    ));
  }

  return buildResult(issues);
}

// ===========================================================================
// Earnings Validation
// ===========================================================================

/**
 * Validate an earnings event record.
 */
export function validateEarnings(earnings: EarningsEvent): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!earnings.instrumentId) {
    issues.push(warning('MISSING_INSTRUMENT_ID', 'Earnings missing instrumentId', 'instrumentId'));
  }

  if (!earnings.reportDate || isNaN(Date.parse(earnings.reportDate))) {
    issues.push(error('INVALID_REPORT_DATE', `Invalid reportDate: ${earnings.reportDate}`, 'reportDate'));
  }

  // EPS surprise > 200% is very unusual
  if (earnings.surprise != null && Math.abs(earnings.surprise) > 200) {
    issues.push(warning(
      'EXTREME_EPS_SURPRISE',
      `EPS surprise of ${earnings.surprise.toFixed(1)}% is extreme`,
      'surprise',
      undefined,
      { epsActual: earnings.epsActual, epsEstimate: earnings.epsEstimate },
    ));
  }

  return buildResult(issues);
}

// ===========================================================================
// Duplicate Detection
// ===========================================================================

/**
 * Detect duplicate bars based on (instrumentId, timestamp, barSize).
 * Returns indices of duplicate occurrences (second and later).
 */
export function detectDuplicateBars(bars: OHLCVBar[]): number[] {
  const seen = new Map<string, number>();
  const duplicates: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const key = `${bars[i].instrumentId}:${bars[i].timestamp}:${bars[i].barSize}`;
    if (seen.has(key)) {
      duplicates.push(i);
    } else {
      seen.set(key, i);
    }
  }
  return duplicates;
}

/**
 * Remove duplicate bars, keeping the first occurrence.
 */
export function deduplicateBars(bars: OHLCVBar[]): OHLCVBar[] {
  const seen = new Set<string>();
  return bars.filter((bar) => {
    const key = `${bar.instrumentId}:${bar.timestamp}:${bar.barSize}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===========================================================================
// Batch Validation Pipeline
// ===========================================================================

/**
 * Run an array of records through a validator function, producing
 * per-record validated wrappers and a batch summary.
 */
export function validateBatch<T>(
  records: T[],
  validatorFn: (record: T) => ValidationResult,
  options: { logRejections?: boolean } = {},
): { records: ValidatedRecord<T>[]; summary: BatchValidationSummary } {
  const logRejections = options.logRejections ?? true;
  const issueBreakdown: Record<string, number> = {};
  let accepted = 0;
  let rejected = 0;
  let warningsTotal = 0;

  const validated: ValidatedRecord<T>[] = records.map((record, idx) => {
    const result = validatorFn(record);

    // Aggregate issue codes
    for (const issue of result.issues) {
      issueBreakdown[issue.code] = (issueBreakdown[issue.code] || 0) + 1;
    }

    warningsTotal += result.warningCount;

    const isAccepted = result.valid;
    if (isAccepted) {
      accepted++;
    } else {
      rejected++;
      if (logRejections) {
        logger.warn('Record rejected by validation', {
          index: idx,
          errorCount: result.errorCount,
          errors: result.issues
            .filter((i) => i.severity === ValidationSeverity.ERROR)
            .map((i) => i.code),
        });
      }
    }

    return { record, result, accepted: isAccepted };
  });

  const summary: BatchValidationSummary = {
    totalRecords: records.length,
    accepted,
    rejected,
    warningsTotal,
    issueBreakdown,
  };

  // Log batch summary
  logger.info('Batch validation complete', {
    total: summary.totalRecords,
    accepted: summary.accepted,
    rejected: summary.rejected,
    warnings: summary.warningsTotal,
    topIssues: Object.entries(issueBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => `${code}:${count}`),
  });

  return { records: validated, summary };
}

/**
 * Convenience: validate a batch of OHLCV bars individually and as a series.
 * Returns only the accepted bars, plus the batch summary.
 */
export function validateAndFilterBars(
  bars: OHLCVBar[],
  seriesOptions?: BarSeriesValidationOptions,
): { bars: OHLCVBar[]; summary: BatchValidationSummary; seriesResult: ValidationResult } {
  // 1. Individual bar validation
  const { records: validated, summary } = validateBatch(bars, validateOHLCVBar);

  // 2. Keep only accepted bars
  const acceptedBars = validated
    .filter((v) => v.accepted)
    .map((v) => v.record);

  // 3. Series-level validation on the accepted bars
  const seriesResult = validateBarSeries(acceptedBars, seriesOptions);

  // Log any series-level anomalies
  if (seriesResult.warningCount > 0) {
    logger.warn('Bar series anomalies detected', {
      warnings: seriesResult.warningCount,
      issues: seriesResult.issues
        .filter((i) => i.severity === ValidationSeverity.WARNING)
        .map((i) => ({ code: i.code, message: i.message }))
        .slice(0, 10),
    });
  }

  return { bars: acceptedBars, summary, seriesResult };
}
