/**
 * Data Validation Pipeline
 *
 * Validates financial market data for consistency and correctness before
 * it enters the storage layer. Catches common data quality issues:
 *
 *   - OHLCV bar integrity (high >= low, non-negative volume, etc.)
 *   - Price continuity (detecting suspicious jumps)
 *   - Timestamp ordering
 *   - Instrument field completeness
 *   - Duplicate detection
 */

import type {
  OHLCVBar,
  Instrument,
  BarSize,
} from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Validation Result Types
// ---------------------------------------------------------------------------

export enum ValidationSeverity {
  ERROR = 'error',     // Data is unusable, must be rejected
  WARNING = 'warning', // Data is suspicious, can be flagged but accepted
}

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  field?: string;
  /** Index in the array where the issue was found (for batch validation) */
  index?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// OHLCV Bar Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single OHLCV bar for data integrity.
 *
 * Checks:
 *   - high >= low
 *   - volume >= 0
 *   - All OHLC prices are positive (non-zero, non-negative)
 *   - Prices are finite numbers
 *   - Timestamp is a valid ISO 8601 string
 */
export function validateOHLCVBar(bar: OHLCVBar): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Price sanity checks
  if (bar.high < bar.low) {
    issues.push({
      severity: ValidationSeverity.ERROR,
      code: 'HIGH_LESS_THAN_LOW',
      message: `High (${bar.high}) is less than low (${bar.low})`,
      field: 'high',
    });
  }

  if (bar.volume < 0) {
    issues.push({
      severity: ValidationSeverity.ERROR,
      code: 'NEGATIVE_VOLUME',
      message: `Volume is negative (${bar.volume})`,
      field: 'volume',
    });
  }

  // Check for zero/empty prices
  if (bar.open === 0 || bar.high === 0 || bar.low === 0 || bar.close === 0) {
    issues.push({
      severity: ValidationSeverity.ERROR,
      code: 'ZERO_PRICE',
      message: 'One or more OHLC prices are zero',
      field: 'open/high/low/close',
    });
  }

  // Check for NaN/Infinity
  for (const [field, value] of Object.entries({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  })) {
    if (!Number.isFinite(value)) {
      issues.push({
        severity: ValidationSeverity.ERROR,
        code: 'NON_FINITE_NUMBER',
        message: `${field} is not a finite number: ${value}`,
        field,
      });
    }
  }

  // Timestamp check
  if (!bar.timestamp || isNaN(Date.parse(bar.timestamp))) {
    issues.push({
      severity: ValidationSeverity.ERROR,
      code: 'INVALID_TIMESTAMP',
      message: `Invalid timestamp: ${bar.timestamp}`,
      field: 'timestamp',
    });
  }

  // Check OHLC relationships (close and open should be between high and low)
  if (Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low)) {
    if (bar.open > bar.high || bar.open < bar.low) {
      issues.push({
        severity: ValidationSeverity.WARNING,
        code: 'OPEN_OUT_OF_RANGE',
        message: `Open (${bar.open}) is outside high-low range [${bar.low}, ${bar.high}]`,
        field: 'open',
      });
    }
    if (bar.close > bar.high || bar.close < bar.low) {
      issues.push({
        severity: ValidationSeverity.WARNING,
        code: 'CLOSE_OUT_OF_RANGE',
        message: `Close (${bar.close}) is outside high-low range [${bar.low}, ${bar.high}]`,
        field: 'close',
      });
    }
  }

  return {
    valid: issues.filter((i) => i.severity === ValidationSeverity.ERROR).length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Bar Series Validation
// ---------------------------------------------------------------------------

/**
 * Validate an ordered series of OHLCV bars.
 *
 * In addition to per-bar validation, checks:
 *   - Chronological timestamp ordering
 *   - Price jump detection (> threshold between consecutive bars)
 *   - Duplicate bar detection (same timestamp)
 *   - Volume spike detection (> multiplier of rolling average)
 *
 * @param bars - Array of OHLCV bars to validate
 * @param options - Validation options
 */
export function validateBarSeries(
  bars: OHLCVBar[],
  options: {
    /** Maximum allowed percentage change between consecutive bars. Default 50 (i.e., 50%). */
    maxPriceJumpPercent?: number;
    /** Volume spike threshold as multiplier of rolling average. Default 10. */
    volumeSpikeMultiplier?: number;
    /** Rolling window for volume average. Default 20. */
    volumeWindow?: number;
  } = {},
): ValidationResult {
  const maxJump = options.maxPriceJumpPercent ?? 50;
  const volMultiplier = options.volumeSpikeMultiplier ?? 10;
  const volWindow = options.volumeWindow ?? 20;

  const issues: ValidationIssue[] = [];

  if (bars.length === 0) {
    return { valid: true, issues: [] };
  }

  // Track volumes for rolling average
  const recentVolumes: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Per-bar validation
    const barResult = validateOHLCVBar(bar);
    for (const issue of barResult.issues) {
      issues.push({ ...issue, index: i });
    }

    if (i > 0) {
      const prevBar = bars[i - 1];

      // Timestamp ordering
      if (bar.timestamp <= prevBar.timestamp) {
        issues.push({
          severity: ValidationSeverity.ERROR,
          code: 'TIMESTAMP_ORDER',
          message: `Bar at index ${i} has timestamp ${bar.timestamp} <= previous ${prevBar.timestamp}`,
          field: 'timestamp',
          index: i,
        });
      }

      // Duplicate timestamp detection
      if (bar.timestamp === prevBar.timestamp) {
        issues.push({
          severity: ValidationSeverity.ERROR,
          code: 'DUPLICATE_TIMESTAMP',
          message: `Duplicate timestamp at index ${i}: ${bar.timestamp}`,
          field: 'timestamp',
          index: i,
        });
      }

      // Price jump detection
      if (prevBar.close > 0) {
        const changePercent =
          Math.abs((bar.close - prevBar.close) / prevBar.close) * 100;
        if (changePercent > maxJump) {
          issues.push({
            severity: ValidationSeverity.WARNING,
            code: 'PRICE_JUMP',
            message: `Price jumped ${changePercent.toFixed(1)}% between bars ${i - 1} and ${i} (threshold: ${maxJump}%)`,
            field: 'close',
            index: i,
          });
        }
      }
    }

    // Volume spike detection
    recentVolumes.push(bar.volume);
    if (recentVolumes.length > volWindow) {
      recentVolumes.shift();
    }

    if (recentVolumes.length >= volWindow) {
      const avgVolume =
        recentVolumes.slice(0, -1).reduce((a, b) => a + b, 0) /
        (recentVolumes.length - 1);
      if (avgVolume > 0 && bar.volume > avgVolume * volMultiplier) {
        issues.push({
          severity: ValidationSeverity.WARNING,
          code: 'VOLUME_SPIKE',
          message: `Volume spike at index ${i}: ${bar.volume} is ${(bar.volume / avgVolume).toFixed(1)}x the ${volWindow}-bar average`,
          field: 'volume',
          index: i,
        });
      }
    }
  }

  return {
    valid: issues.filter((i) => i.severity === ValidationSeverity.ERROR).length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Instrument Field Validation
// ---------------------------------------------------------------------------

/**
 * Validate completeness of instrument fields.
 *
 * Required fields: id, type, assetClass, name, primaryTicker, currency
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
      issues.push({
        severity: ValidationSeverity.ERROR,
        code: 'MISSING_REQUIRED_FIELD',
        message: `${label} is required`,
        field,
      });
    }
  }

  // Validate ticker format
  if (instrument.primaryTicker && !/^[A-Z0-9./-]{1,20}$/.test(instrument.primaryTicker)) {
    issues.push({
      severity: ValidationSeverity.WARNING,
      code: 'INVALID_TICKER_FORMAT',
      message: `Ticker format may be invalid: ${instrument.primaryTicker}`,
      field: 'primaryTicker',
    });
  }

  // Validate currency code (3 uppercase letters)
  if (instrument.currency && !/^[A-Z]{3}$/.test(instrument.currency)) {
    issues.push({
      severity: ValidationSeverity.ERROR,
      code: 'INVALID_CURRENCY',
      message: `Invalid currency code: ${instrument.currency}`,
      field: 'currency',
    });
  }

  // Validate country code (2 uppercase letters)
  if (instrument.country && !/^[A-Z]{2}$/.test(instrument.country)) {
    issues.push({
      severity: ValidationSeverity.WARNING,
      code: 'INVALID_COUNTRY',
      message: `Invalid country code: ${instrument.country}`,
      field: 'country',
    });
  }

  return {
    valid: issues.filter((i) => i.severity === ValidationSeverity.ERROR).length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Duplicate Detection
// ---------------------------------------------------------------------------

/**
 * Detect duplicate bars in a series based on timestamp.
 *
 * @param bars - Array of OHLCV bars
 * @returns Indices of duplicate bars (the second and subsequent occurrences)
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
 * Remove duplicate bars from a series, keeping the first occurrence.
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
