/**
 * Data Normalization Layer
 *
 * Normalizes raw data from various exchanges and providers into
 * the canonical types defined in shared/types/instrument.ts.
 *
 * Responsibilities:
 *   - Multi-exchange ticker resolution (same instrument on different exchanges)
 *   - FX pair normalization (enforce base/quote convention)
 *   - Adjusted vs unadjusted price calculation for stock splits
 *   - Timestamp normalization to UTC from exchange-local timezones
 *   - Handling of missing/null fields with safe defaults
 *   - ISIN format validation
 */

import type {
  OHLCVBar,
  CorporateAction,
  CorporateActionType,
  Instrument,
  FxInstrument,
  BarSize,
  ISIN,
} from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// ISIN Validation
// ---------------------------------------------------------------------------

/**
 * Validate an ISIN (ISO 6166) format.
 *
 * Format: 2-letter country code + 9 alphanumeric characters + 1 check digit
 * Total: 12 characters
 *
 * Also validates the Luhn check digit.
 */
export function validateISIN(isin: string): { valid: boolean; error?: string } {
  if (!isin || typeof isin !== 'string') {
    return { valid: false, error: 'ISIN is required' };
  }

  if (isin.length !== 12) {
    return { valid: false, error: `ISIN must be 12 characters, got ${isin.length}` };
  }

  // First 2 chars: ISO 3166-1 alpha-2 country code (letters only)
  const countryCode = isin.substring(0, 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { valid: false, error: 'ISIN must start with a 2-letter country code' };
  }

  // Characters 3-11: alphanumeric NSIN (National Securities Identifying Number)
  const nsin = isin.substring(2, 11);
  if (!/^[A-Z0-9]{9}$/.test(nsin)) {
    return { valid: false, error: 'ISIN NSIN portion must be 9 alphanumeric characters' };
  }

  // Character 12: check digit (numeric)
  const checkDigit = isin.charAt(11);
  if (!/^[0-9]$/.test(checkDigit)) {
    return { valid: false, error: 'ISIN check digit must be numeric' };
  }

  // Luhn check digit validation
  const digits = isinToDigits(isin.substring(0, 11));
  const computedCheck = luhnCheckDigit(digits);
  if (computedCheck !== parseInt(checkDigit, 10)) {
    return {
      valid: false,
      error: `ISIN check digit mismatch: expected ${computedCheck}, got ${checkDigit}`,
    };
  }

  return { valid: true };
}

/** Convert ISIN letters to digits: A=10, B=11, ..., Z=35 */
function isinToDigits(isinWithoutCheck: string): number[] {
  const digits: number[] = [];
  for (const ch of isinWithoutCheck) {
    if (ch >= '0' && ch <= '9') {
      digits.push(parseInt(ch, 10));
    } else {
      // A=10, B=11, ..., Z=35
      const val = ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      digits.push(Math.floor(val / 10));
      digits.push(val % 10);
    }
  }
  return digits;
}

/** Compute Luhn check digit for a sequence of digits. */
function luhnCheckDigit(digits: number[]): number {
  let sum = 0;
  let doubleNext = true; // Start doubling from rightmost

  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (doubleNext) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleNext = !doubleNext;
  }

  return (10 - (sum % 10)) % 10;
}

// ---------------------------------------------------------------------------
// FX Pair Normalization
// ---------------------------------------------------------------------------

/**
 * Standard FX pair convention: certain currencies always appear as base.
 *
 * Priority order (highest to lowest):
 *   EUR > GBP > AUD > NZD > USD > CAD > CHF > JPY
 *
 * This ensures EUR/USD is never quoted as USD/EUR.
 */
const FX_PRIORITY: Record<string, number> = {
  EUR: 8,
  GBP: 7,
  AUD: 6,
  NZD: 5,
  USD: 4,
  CAD: 3,
  CHF: 2,
  JPY: 1,
};

export interface NormalizedFxPair {
  base: string;
  quote: string;
  pair: string;        // e.g. "EUR/USD"
  wasInverted: boolean;
}

/**
 * Normalize an FX pair to standard base/quote convention.
 *
 * @param currencyA - First currency code
 * @param currencyB - Second currency code
 * @returns Normalized pair with base/quote in standard order
 */
export function normalizeFxPair(currencyA: string, currencyB: string): NormalizedFxPair {
  const a = currencyA.toUpperCase();
  const b = currencyB.toUpperCase();

  const priorityA = FX_PRIORITY[a] ?? 0;
  const priorityB = FX_PRIORITY[b] ?? 0;

  if (priorityA >= priorityB) {
    return { base: a, quote: b, pair: `${a}/${b}`, wasInverted: false };
  } else {
    return { base: b, quote: a, pair: `${b}/${a}`, wasInverted: true };
  }
}

// ---------------------------------------------------------------------------
// Exchange Ticker Resolution
// ---------------------------------------------------------------------------

export interface TickerResolution {
  /** Canonical instrument ID */
  instrumentId: string;
  /** Primary exchange MIC */
  primaryExchangeMic: string;
  /** Whether this ticker was found as a primary or alias */
  matchType: 'primary' | 'alias';
}

/** Registry entry for multi-exchange ticker lookups */
export interface TickerRegistryEntry {
  instrumentId: string;
  primaryTicker: string;
  primaryExchangeMic: string;
  aliases: Array<{ ticker: string; exchangeMic: string }>;
}

/**
 * Resolve a ticker symbol to a canonical instrument.
 *
 * When the same ticker exists on multiple exchanges (e.g., AAPL on XNAS and XNYS),
 * the exchange MIC is used to disambiguate. If no exchange is specified, the
 * primary listing is returned.
 *
 * @param ticker - The ticker symbol to resolve
 * @param exchangeMic - Optional exchange MIC for disambiguation
 * @param registry - Ticker registry to search
 */
export function resolveTickerToInstrument(
  ticker: string,
  exchangeMic: string | undefined,
  registry: TickerRegistryEntry[],
): TickerResolution | null {
  const upperTicker = ticker.toUpperCase();

  // First: exact match on primary ticker + exchange
  for (const entry of registry) {
    if (entry.primaryTicker.toUpperCase() === upperTicker) {
      if (!exchangeMic || entry.primaryExchangeMic === exchangeMic) {
        return {
          instrumentId: entry.instrumentId,
          primaryExchangeMic: entry.primaryExchangeMic,
          matchType: 'primary',
        };
      }
    }
  }

  // Second: search aliases
  for (const entry of registry) {
    for (const alias of entry.aliases) {
      if (alias.ticker.toUpperCase() === upperTicker) {
        if (!exchangeMic || alias.exchangeMic === exchangeMic) {
          return {
            instrumentId: entry.instrumentId,
            primaryExchangeMic: entry.primaryExchangeMic,
            matchType: 'alias',
          };
        }
      }
    }
  }

  // Third: fallback - match by primary ticker ignoring exchange
  for (const entry of registry) {
    if (entry.primaryTicker.toUpperCase() === upperTicker) {
      return {
        instrumentId: entry.instrumentId,
        primaryExchangeMic: entry.primaryExchangeMic,
        matchType: 'primary',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adjusted Price Calculation
// ---------------------------------------------------------------------------

/**
 * Apply a stock split adjustment to a price.
 *
 * For a forward split (e.g., 4:1), pre-split prices are divided by the ratio.
 * For a reverse split (e.g., 1:4), pre-split prices are multiplied by the ratio.
 *
 * @param price - The unadjusted price
 * @param splitRatio - The split ratio (e.g., 4 for a 4:1 split)
 * @param isReverseSplit - Whether this is a reverse split
 */
export function adjustPriceForSplit(
  price: number,
  splitRatio: number,
  isReverseSplit: boolean = false,
): number {
  if (splitRatio <= 0) {
    throw new Error(`Split ratio must be positive, got ${splitRatio}`);
  }

  if (isReverseSplit) {
    return price * splitRatio;
  }
  return price / splitRatio;
}

/**
 * Apply split adjustment to an array of OHLCV bars.
 *
 * Bars before the split ex-date have their prices adjusted.
 * Bars on or after the ex-date are left unchanged.
 *
 * @param bars - Array of OHLCV bars (chronologically sorted)
 * @param splitExDate - ISO 8601 date string of the split ex-date
 * @param splitRatio - The split ratio
 * @param isReverseSplit - Whether this is a reverse split
 */
export function adjustBarsForSplit(
  bars: OHLCVBar[],
  splitExDate: string,
  splitRatio: number,
  isReverseSplit: boolean = false,
): OHLCVBar[] {
  return bars.map((bar) => {
    const barDate = bar.timestamp.slice(0, 10);
    if (barDate < splitExDate) {
      return {
        ...bar,
        open: adjustPriceForSplit(bar.open, splitRatio, isReverseSplit),
        high: adjustPriceForSplit(bar.high, splitRatio, isReverseSplit),
        low: adjustPriceForSplit(bar.low, splitRatio, isReverseSplit),
        close: adjustPriceForSplit(bar.close, splitRatio, isReverseSplit),
        vwap: bar.vwap != null
          ? adjustPriceForSplit(bar.vwap, splitRatio, isReverseSplit)
          : null,
        volume: isReverseSplit
          ? Math.round(bar.volume / splitRatio)
          : Math.round(bar.volume * splitRatio),
        isAdjusted: true,
      };
    }
    return { ...bar, isAdjusted: true };
  });
}

// ---------------------------------------------------------------------------
// Timestamp Normalization
// ---------------------------------------------------------------------------

/**
 * Known exchange timezone offsets from UTC.
 * In a production system, this would use a proper timezone library (e.g., luxon).
 */
const EXCHANGE_TIMEZONE_OFFSETS: Record<string, number> = {
  XNYS: -5,   // NYSE — US Eastern (EST, ignoring DST for simplicity)
  XNAS: -5,   // NASDAQ — US Eastern
  XCHI: -6,   // Chicago — US Central
  XTSE: -5,   // Toronto — US Eastern
  XLON: 0,    // London — GMT/UTC
  XPAR: 1,    // Paris — CET
  XFRA: 1,    // Frankfurt — CET
  XETR: 1,    // XETRA — CET
  XTKS: 9,    // Tokyo — JST
  XHKG: 8,    // Hong Kong — HKT
  XASX: 11,   // Sydney — AEDT
  XBOM: 5.5,  // Bombay — IST
};

/**
 * Normalize a local exchange timestamp to UTC.
 *
 * @param localTimestamp - Timestamp string (ISO 8601 or epoch ms)
 * @param exchangeMic - Exchange MIC for timezone lookup
 * @returns ISO 8601 UTC timestamp string
 */
export function normalizeTimestampToUTC(
  localTimestamp: string | number,
  exchangeMic: string,
): string {
  const offset = EXCHANGE_TIMEZONE_OFFSETS[exchangeMic];

  if (offset === undefined) {
    // Unknown exchange, assume already UTC
    if (typeof localTimestamp === 'number') {
      return new Date(localTimestamp).toISOString();
    }
    return new Date(localTimestamp).toISOString();
  }

  let dateMs: number;
  if (typeof localTimestamp === 'number') {
    dateMs = localTimestamp;
  } else {
    dateMs = new Date(localTimestamp).getTime();
  }

  // Subtract the offset to convert local time to UTC
  const utcMs = dateMs - offset * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

// ---------------------------------------------------------------------------
// Missing Field Handling
// ---------------------------------------------------------------------------

/**
 * Sanitize an OHLCV bar by filling missing/null fields with safe defaults.
 *
 * Rules:
 *   - If VWAP is null, compute from (high + low + close) / 3
 *   - If trades is null, leave as null
 *   - If volume is NaN or null, set to 0
 *   - All prices must be finite numbers
 *
 * @returns Sanitized bar, or null if the bar is unrecoverable
 */
export function sanitizeBar(bar: Partial<OHLCVBar>): OHLCVBar | null {
  const open = bar.open;
  const high = bar.high;
  const low = bar.low;
  const close = bar.close;

  // All OHLC prices are required and must be finite
  if (
    open == null || !Number.isFinite(open) ||
    high == null || !Number.isFinite(high) ||
    low == null || !Number.isFinite(low) ||
    close == null || !Number.isFinite(close)
  ) {
    return null;
  }

  // Zero prices are invalid for most instruments
  if (open === 0 && high === 0 && low === 0 && close === 0) {
    return null;
  }

  const volume = (bar.volume != null && Number.isFinite(bar.volume)) ? bar.volume : 0;

  const vwap = bar.vwap != null && Number.isFinite(bar.vwap)
    ? bar.vwap
    : (high + low + close) / 3;

  return {
    instrumentId: bar.instrumentId ?? '',
    timestamp: bar.timestamp ?? new Date().toISOString(),
    open,
    high,
    low,
    close,
    volume,
    vwap,
    trades: bar.trades ?? null,
    barSize: bar.barSize ?? ('1d' as BarSize),
    isAdjusted: bar.isAdjusted ?? false,
    source: bar.source ?? 'unknown',
  };
}
