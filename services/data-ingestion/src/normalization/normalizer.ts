/**
 * Central Data Normalization Module
 *
 * Responsible for:
 *  - Mapping multi-exchange / multi-source tickers to canonical instrument IDs
 *  - FX pair normalization (enforcing deterministic base/quote ordering)
 *  - Adjusted vs unadjusted price transformation via corporate actions
 *  - Timestamp normalization to UTC from any format / timezone
 *  - Cross-source data reconciliation and inconsistency detection
 *  - ISIN validation
 *  - Missing field sanitization
 */

import type {
  OHLCVBar,
  CorporateAction,
  Instrument,
  FxInstrument,
  BarSize,
  Tick,
  ISIN,
  TickerAlias,
  CurrencyCode,
} from '../../../../shared/src/types/instrument';
import {
  CorporateActionType,
  InstrumentType,
} from '../../../../shared/src/types/instrument';
import { Logger } from '../../../../shared/src/utils/logger';

const logger = new Logger('normalizer');

// ===========================================================================
// ISIN Validation
// ===========================================================================

/**
 * Validate an ISIN (ISO 6166) format.
 *
 * Format: 2-letter country code + 9 alphanumeric characters + 1 check digit
 * Total: 12 characters.  Also validates the Luhn check digit.
 */
export function validateISIN(isin: string): { valid: boolean; error?: string } {
  if (!isin || typeof isin !== 'string') {
    return { valid: false, error: 'ISIN is required' };
  }
  if (isin.length !== 12) {
    return { valid: false, error: `ISIN must be 12 characters, got ${isin.length}` };
  }

  const countryCode = isin.substring(0, 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { valid: false, error: 'ISIN must start with a 2-letter country code' };
  }

  const nsin = isin.substring(2, 11);
  if (!/^[A-Z0-9]{9}$/.test(nsin)) {
    return { valid: false, error: 'ISIN NSIN portion must be 9 alphanumeric characters' };
  }

  const checkDigit = isin.charAt(11);
  if (!/^[0-9]$/.test(checkDigit)) {
    return { valid: false, error: 'ISIN check digit must be numeric' };
  }

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

function isinToDigits(isinWithoutCheck: string): number[] {
  const digits: number[] = [];
  for (const ch of isinWithoutCheck) {
    if (ch >= '0' && ch <= '9') {
      digits.push(parseInt(ch, 10));
    } else {
      const val = ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      digits.push(Math.floor(val / 10));
      digits.push(val % 10);
    }
  }
  return digits;
}

function luhnCheckDigit(digits: number[]): number {
  let sum = 0;
  let doubleNext = true;
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

// ===========================================================================
// Instrument Registry
// ===========================================================================

/**
 * In-memory instrument registry that maps source-specific tickers, ISINs,
 * FIGIs, and primary tickers to canonical Instrument records.
 *
 * In production this would be backed by Postgres + a Redis cache, but the
 * lookup semantics are identical.
 */
export class InstrumentRegistry {
  /** instrumentId -> Instrument */
  private readonly instruments = new Map<string, Instrument>();
  /** Composite key "source:ticker" -> instrumentId */
  private readonly tickerIndex = new Map<string, string>();
  /** ISIN -> instrumentId */
  private readonly isinIndex = new Map<string, string>();
  /** FIGI -> instrumentId */
  private readonly figiIndex = new Map<string, string>();
  /** primaryTicker (upper) -> instrumentId */
  private readonly primaryTickerIndex = new Map<string, string>();

  register(instrument: Instrument): void {
    this.instruments.set(instrument.id, instrument);
    this.primaryTickerIndex.set(instrument.primaryTicker.toUpperCase(), instrument.id);
    if (instrument.isin) this.isinIndex.set(instrument.isin, instrument.id);
    if (instrument.figi) this.figiIndex.set(instrument.figi, instrument.id);
    for (const alias of instrument.tickerAliases) {
      this.tickerIndex.set(this.aliasKey(alias.source, alias.ticker), instrument.id);
    }
  }

  resolveBySourceTicker(source: string, ticker: string): Instrument | null {
    const key = this.aliasKey(source, ticker);
    const id = this.tickerIndex.get(key);
    if (id) return this.instruments.get(id) || null;
    // Fall back to primary ticker
    const byPrimary = this.primaryTickerIndex.get(ticker.toUpperCase());
    if (byPrimary) return this.instruments.get(byPrimary) || null;
    return null;
  }

  resolveById(id: string): Instrument | null {
    return this.instruments.get(id) || null;
  }

  resolveByIsin(isin: string): Instrument | null {
    const id = this.isinIndex.get(isin);
    return id ? this.instruments.get(id) || null : null;
  }

  resolveByFigi(figi: string): Instrument | null {
    const id = this.figiIndex.get(figi);
    return id ? this.instruments.get(id) || null : null;
  }

  addAlias(instrumentId: string, alias: TickerAlias): void {
    const instrument = this.instruments.get(instrumentId);
    if (!instrument) {
      logger.warn('Cannot add alias: instrument not found', { instrumentId });
      return;
    }
    instrument.tickerAliases.push(alias);
    this.tickerIndex.set(this.aliasKey(alias.source, alias.ticker), instrumentId);
    instrument.updatedAt = new Date().toISOString();
  }

  getAll(): Instrument[] {
    return Array.from(this.instruments.values());
  }

  /** Build a mapping from source tickers to instrument IDs for a given source */
  buildSourceTickerMap(source: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const instrument of this.instruments.values()) {
      for (const alias of instrument.tickerAliases) {
        if (alias.source === source) {
          map[alias.ticker] = instrument.id;
        }
      }
    }
    return map;
  }

  private aliasKey(source: string, ticker: string): string {
    return `${source.toLowerCase()}:${ticker.toUpperCase()}`;
  }
}

// ===========================================================================
// Multi-exchange Ticker Resolution (legacy array-based API)
// ===========================================================================

export interface TickerResolution {
  instrumentId: string;
  primaryExchangeMic: string;
  matchType: 'primary' | 'alias';
}

export interface TickerRegistryEntry {
  instrumentId: string;
  primaryTicker: string;
  primaryExchangeMic: string;
  aliases: Array<{ ticker: string; exchangeMic: string }>;
}

/**
 * Resolve a ticker symbol to a canonical instrument, optionally
 * disambiguating by exchange MIC when the same ticker trades on
 * multiple venues.
 */
export function resolveTickerToInstrument(
  ticker: string,
  exchangeMic: string | undefined,
  registry: TickerRegistryEntry[],
): TickerResolution | null {
  const upperTicker = ticker.toUpperCase();

  // Exact match on primary ticker + exchange
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

  // Search aliases
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

  // Fallback: match primary ticker ignoring exchange
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

// ===========================================================================
// FX Pair Normalization
// ===========================================================================

/**
 * Standard FX pair convention priority (higher number = higher priority).
 * The currency with higher priority is always the base.
 * E.g. EUR/USD is correct, never USD/EUR.
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
 * If the supplied ordering disagrees with convention, `wasInverted` is true
 * and the caller should invert the rate (1/rate).
 */
export function normalizeFxPair(currencyA: string, currencyB: string): NormalizedFxPair {
  const a = currencyA.toUpperCase();
  const b = currencyB.toUpperCase();

  const priorityA = FX_PRIORITY[a] ?? 0;
  const priorityB = FX_PRIORITY[b] ?? 0;

  if (priorityA > priorityB || (priorityA === priorityB && a <= b)) {
    return { base: a, quote: b, pair: `${a}/${b}`, wasInverted: false };
  }
  return { base: b, quote: a, pair: `${b}/${a}`, wasInverted: true };
}

/**
 * Invert an FX rate if the pair was reordered during normalisation.
 */
export function adjustFxRate(rate: number, wasInverted: boolean): number {
  if (!wasInverted || rate === 0) return rate;
  return 1 / rate;
}

// ===========================================================================
// Corporate Action Price Adjustment
// ===========================================================================

/**
 * Apply corporate actions to raw (unadjusted) OHLCV bars.
 *
 * Actions are applied cumulatively: bars that predate an action's ex-date
 * have all subsequent actions folded in.  This replicates the standard
 * "backward adjustment" method used by Bloomberg, Polygon, etc.
 *
 * Supported types:
 *  - SPLIT / REVERSE_SPLIT: price *= 1/ratio (or ratio); volume *= ratio (or 1/ratio)
 *  - DIVIDEND / SPECIAL_DIVIDEND: price -= amount (per share)
 */
export function applyAdjustments(
  bars: OHLCVBar[],
  actions: CorporateAction[],
): OHLCVBar[] {
  if (actions.length === 0) return bars.map((b) => ({ ...b, isAdjusted: true }));

  // Sort actions newest-first
  const sorted = [...actions].sort(
    (a, b) => new Date(b.exDate).getTime() - new Date(a.exDate).getTime(),
  );

  // Sort bars ascending by timestamp
  const sortedBars = [...bars].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Build breakpoints
  interface Breakpoint {
    exDate: Date;
    priceFactor: number;
    volumeFactor: number;
    priceSubtract: number;
  }

  const breakpoints: Breakpoint[] = [];

  for (const action of sorted) {
    const exDate = new Date(action.exDate);

    switch (action.type) {
      case CorporateActionType.SPLIT: {
        const ratio = action.ratio ?? 1;
        if (ratio <= 0) {
          logger.warn('Invalid split ratio, skipping', { ratio, exDate: action.exDate });
          continue;
        }
        breakpoints.push({ exDate, priceFactor: 1 / ratio, volumeFactor: ratio, priceSubtract: 0 });
        break;
      }
      case CorporateActionType.REVERSE_SPLIT: {
        const ratio = action.ratio ?? 1;
        if (ratio <= 0) {
          logger.warn('Invalid reverse split ratio, skipping', { ratio });
          continue;
        }
        breakpoints.push({ exDate, priceFactor: ratio, volumeFactor: 1 / ratio, priceSubtract: 0 });
        break;
      }
      case CorporateActionType.DIVIDEND:
      case CorporateActionType.SPECIAL_DIVIDEND: {
        const amount = action.amount ?? 0;
        if (amount < 0) {
          logger.warn('Negative dividend amount, skipping', { amount });
          continue;
        }
        breakpoints.push({ exDate, priceFactor: 1, volumeFactor: 1, priceSubtract: amount });
        break;
      }
      default:
        logger.debug('Skipping non-price corporate action', { type: action.type });
    }
  }

  if (breakpoints.length === 0) {
    return sortedBars.map((b) => ({ ...b, isAdjusted: true }));
  }

  breakpoints.sort((a, b) => b.exDate.getTime() - a.exDate.getTime());

  return sortedBars.map((bar) => {
    const barDate = new Date(bar.timestamp);
    let cumPriceFactor = 1;
    let cumVolumeFactor = 1;
    let cumPriceSubtract = 0;

    for (const bp of breakpoints) {
      if (barDate < bp.exDate) {
        cumPriceFactor *= bp.priceFactor;
        cumVolumeFactor *= bp.volumeFactor;
        cumPriceSubtract += bp.priceSubtract * cumPriceFactor;
      }
    }

    const adj = (p: number) => Math.max(0, p * cumPriceFactor - cumPriceSubtract);

    return {
      ...bar,
      open: roundPrice(adj(bar.open)),
      high: roundPrice(adj(bar.high)),
      low: roundPrice(adj(bar.low)),
      close: roundPrice(adj(bar.close)),
      volume: Math.round(bar.volume * cumVolumeFactor),
      vwap: bar.vwap != null ? roundPrice(adj(bar.vwap)) : null,
      isAdjusted: true,
    };
  });
}

/** Simple split-only adjustment helper (convenience API) */
export function adjustPriceForSplit(
  price: number,
  splitRatio: number,
  isReverseSplit: boolean = false,
): number {
  if (splitRatio <= 0) throw new Error(`Split ratio must be positive, got ${splitRatio}`);
  return isReverseSplit ? price * splitRatio : price / splitRatio;
}

/** Apply a single split to an array of bars */
export function adjustBarsForSplit(
  bars: OHLCVBar[],
  splitExDate: string,
  splitRatio: number,
  isReverseSplit: boolean = false,
): OHLCVBar[] {
  return bars.map((bar) => {
    if (bar.timestamp.slice(0, 10) < splitExDate) {
      return {
        ...bar,
        open: adjustPriceForSplit(bar.open, splitRatio, isReverseSplit),
        high: adjustPriceForSplit(bar.high, splitRatio, isReverseSplit),
        low: adjustPriceForSplit(bar.low, splitRatio, isReverseSplit),
        close: adjustPriceForSplit(bar.close, splitRatio, isReverseSplit),
        vwap: bar.vwap != null ? adjustPriceForSplit(bar.vwap, splitRatio, isReverseSplit) : null,
        volume: isReverseSplit
          ? Math.round(bar.volume / splitRatio)
          : Math.round(bar.volume * splitRatio),
        isAdjusted: true,
      };
    }
    return { ...bar, isAdjusted: true };
  });
}

/**
 * Reverse adjustments: given adjusted bars and corporate actions,
 * produce unadjusted bars.
 */
export function reverseAdjustments(
  adjustedBars: OHLCVBar[],
  actions: CorporateAction[],
): OHLCVBar[] {
  if (actions.length === 0) return adjustedBars.map((b) => ({ ...b, isAdjusted: false }));

  const invertedActions: CorporateAction[] = actions.map((a) => {
    const inv = { ...a };
    if (a.type === CorporateActionType.SPLIT && a.ratio) {
      inv.type = CorporateActionType.REVERSE_SPLIT;
    } else if (a.type === CorporateActionType.REVERSE_SPLIT && a.ratio) {
      inv.type = CorporateActionType.SPLIT;
    } else if (
      (a.type === CorporateActionType.DIVIDEND || a.type === CorporateActionType.SPECIAL_DIVIDEND) &&
      a.amount
    ) {
      inv.amount = -a.amount;
    }
    return inv;
  });

  return applyAdjustments(adjustedBars, invertedActions).map((b) => ({ ...b, isAdjusted: false }));
}

// ===========================================================================
// Timestamp Normalization
// ===========================================================================

/** Known exchange timezone offsets from UTC (hours). */
const EXCHANGE_TIMEZONE_OFFSETS: Record<string, number> = {
  XNYS: -5,  XNAS: -5,  XCHI: -6,  XTSE: -5,
  XLON: 0,   XPAR: 1,   XFRA: 1,   XETR: 1,
  XTKS: 9,   XHKG: 8,   XASX: 11,  XBOM: 5.5,
  ARCX: -5,  IEXG: -5,  BATS: -5,  EDGA: -5,  EDGX: -5,
};

/**
 * Normalize a local exchange timestamp to UTC.
 */
export function normalizeTimestampToUTC(
  localTimestamp: string | number,
  exchangeMic: string,
): string {
  const offset = EXCHANGE_TIMEZONE_OFFSETS[exchangeMic];
  let dateMs: number;

  if (typeof localTimestamp === 'number') {
    dateMs = localTimestamp < 1e12 ? localTimestamp * 1000 : localTimestamp;
  } else {
    dateMs = new Date(localTimestamp).getTime();
  }

  if (isNaN(dateMs)) {
    logger.warn('Unparseable timestamp', { localTimestamp, exchangeMic });
    return typeof localTimestamp === 'string' ? localTimestamp : new Date().toISOString();
  }

  if (offset !== undefined) {
    dateMs -= offset * 3600_000;
  }

  return new Date(dateMs).toISOString();
}

/**
 * Parse any reasonable timestamp format into ISO 8601 UTC.
 *
 * Handles:
 *  - Unix epoch seconds and milliseconds
 *  - ISO 8601 with or without timezone
 *  - YYYY-MM-DD (date only, assumes midnight UTC)
 *  - MM/DD/YYYY US date format
 */
export function normalizeTimestamp(input: string | number): string {
  if (typeof input === 'number') {
    return new Date(input < 1e12 ? input * 1000 : input).toISOString();
  }

  const trimmed = input.trim();
  let date = new Date(trimmed);

  if (isNaN(date.getTime())) {
    // MM/DD/YYYY
    const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch) {
      const [, m, d, y] = usMatch;
      date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00Z`);
    }
  }

  if (isNaN(date.getTime())) {
    const isoDate = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
      date = new Date(trimmed + 'T00:00:00Z');
    }
  }

  if (isNaN(date.getTime())) {
    logger.warn('Failed to parse timestamp', { input });
    return input;
  }

  return date.toISOString();
}

// ===========================================================================
// Bar and Tick Normalization
// ===========================================================================

/**
 * Normalize an array of OHLCV bars: ensure timestamps are UTC ISO 8601,
 * sort ascending, and de-duplicate by (instrumentId, timestamp, barSize).
 */
export function normalizeBars(bars: OHLCVBar[]): OHLCVBar[] {
  const normalized = bars.map((bar) => ({
    ...bar,
    timestamp: normalizeTimestamp(bar.timestamp),
  }));

  normalized.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const seen = new Set<string>();
  const deduped: OHLCVBar[] = [];

  for (const bar of normalized) {
    const key = `${bar.instrumentId}|${bar.timestamp}|${bar.barSize}`;
    if (seen.has(key)) {
      logger.debug('Duplicate bar removed', { key });
      continue;
    }
    seen.add(key);
    deduped.push(bar);
  }

  return deduped;
}

/**
 * Normalize an array of ticks: UTC timestamps, sort ascending.
 */
export function normalizeTicks(ticks: Tick[]): Tick[] {
  return ticks
    .map((t) => ({ ...t, timestamp: normalizeTimestamp(t.timestamp) }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ===========================================================================
// Missing Field Sanitization
// ===========================================================================

/**
 * Sanitize an OHLCV bar by filling missing/null fields with safe defaults.
 * Returns null if the bar is unrecoverable (e.g. all-zero prices).
 */
export function sanitizeBar(bar: Partial<OHLCVBar>): OHLCVBar | null {
  const { open, high, low, close } = bar;

  if (
    open == null || !Number.isFinite(open) ||
    high == null || !Number.isFinite(high) ||
    low == null || !Number.isFinite(low) ||
    close == null || !Number.isFinite(close)
  ) {
    return null;
  }

  if (open === 0 && high === 0 && low === 0 && close === 0) {
    return null;
  }

  const volume = (bar.volume != null && Number.isFinite(bar.volume)) ? bar.volume : 0;

  const vwap = (bar.vwap != null && Number.isFinite(bar.vwap))
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

// ===========================================================================
// Cross-Source Reconciliation
// ===========================================================================

export interface ReconciliationResult {
  instrumentId: string;
  date: string;
  sources: string[];
  closePrices: Record<string, number>;
  maxDivergencePct: number;
  isConsistent: boolean;
}

/**
 * Compare bars from multiple sources for the same instrument on the same
 * dates, flagging significant price divergences.
 */
export function reconcileBars(
  barsBySource: Record<string, OHLCVBar[]>,
  tolerancePct: number = 1.0,
): ReconciliationResult[] {
  const byDate = new Map<string, Record<string, OHLCVBar>>();

  for (const [source, bars] of Object.entries(barsBySource)) {
    for (const bar of bars) {
      const dateKey = bar.timestamp.slice(0, 10);
      if (!byDate.has(dateKey)) byDate.set(dateKey, {});
      byDate.get(dateKey)![source] = bar;
    }
  }

  const results: ReconciliationResult[] = [];

  for (const [date, sourceBars] of byDate.entries()) {
    const sources = Object.keys(sourceBars);
    if (sources.length < 2) continue;

    const closePrices: Record<string, number> = {};
    for (const [source, bar] of Object.entries(sourceBars)) {
      closePrices[source] = bar.close;
    }

    const prices = Object.values(closePrices);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const maxDivergencePct = minPrice > 0
      ? ((maxPrice - minPrice) / minPrice) * 100
      : 0;

    const isConsistent = maxDivergencePct <= tolerancePct;

    if (!isConsistent) {
      logger.warn('Cross-source price divergence', {
        instrumentId: Object.values(sourceBars)[0].instrumentId,
        date,
        closePrices,
        maxDivergencePct: maxDivergencePct.toFixed(3),
      });
    }

    results.push({
      instrumentId: Object.values(sourceBars)[0].instrumentId,
      date,
      sources,
      closePrices,
      maxDivergencePct: parseFloat(maxDivergencePct.toFixed(3)),
      isConsistent,
    });
  }

  return results;
}

// ===========================================================================
// Helpers
// ===========================================================================

function roundPrice(price: number): number {
  return Math.round(price * 1e6) / 1e6;
}
