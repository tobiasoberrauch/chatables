/**
 * Frontend type definitions.
 *
 * These mirror the canonical types in @chatables/shared but are kept standalone
 * so the frontend bundle has zero Node-only dependencies. When the shared
 * package is consumed via a compiled NPM artefact these can be replaced with
 * direct re-exports.
 */

/* ------------------------------------------------------------------ */
/*  Primitives                                                        */
/* ------------------------------------------------------------------ */

export type MIC = string;
export type CurrencyCode = string;
export type ISIN = string;
export type FIGI = string;

/* ------------------------------------------------------------------ */
/*  Enums                                                             */
/* ------------------------------------------------------------------ */

export enum InstrumentType {
  EQUITY = 'EQUITY',
  ETF = 'ETF',
  FX = 'FX',
  INDEX = 'INDEX',
  BOND = 'BOND',
  OPTION = 'OPTION',
  FUTURE = 'FUTURE',
  CRYPTO = 'CRYPTO',
}

export enum AssetClass {
  EQUITY = 'EQUITY',
  FIXED_INCOME = 'FIXED_INCOME',
  FX = 'FX',
  COMMODITY = 'COMMODITY',
  CRYPTO = 'CRYPTO',
}

export enum BarSize {
  TICK = 'tick',
  SECOND_1 = '1s',
  MINUTE_1 = '1m',
  MINUTE_5 = '5m',
  MINUTE_15 = '15m',
  MINUTE_30 = '30m',
  HOUR_1 = '1h',
  HOUR_4 = '4h',
  DAY_1 = '1d',
  WEEK_1 = '1w',
  MONTH_1 = '1M',
}

export enum MacroCategory {
  EMPLOYMENT = 'EMPLOYMENT',
  INFLATION = 'INFLATION',
  GDP = 'GDP',
  CENTRAL_BANK = 'CENTRAL_BANK',
  HOUSING = 'HOUSING',
  MANUFACTURING = 'MANUFACTURING',
  CONSUMER = 'CONSUMER',
  TRADE = 'TRADE',
}

export enum WSEventType {
  TICK = 'tick',
  QUOTE = 'quote',
  BAR = 'bar',
  NEWS = 'news',
  MACRO_EVENT = 'macro_event',
  EARNINGS = 'earnings',
  ANALYTICS = 'analytics',
  HEARTBEAT = 'heartbeat',
  ERROR = 'error',
  SUBSCRIBE_ACK = 'subscribe_ack',
  UNSUBSCRIBE_ACK = 'unsubscribe_ack',
}

export enum UserRole {
  VIEWER = 'viewer',
  ANALYST = 'analyst',
  ADMIN = 'admin',
}

/* ------------------------------------------------------------------ */
/*  Instrument                                                        */
/* ------------------------------------------------------------------ */

export interface TickerAlias {
  source: string;
  ticker: string;
  exchangeMic?: MIC;
}

export interface Instrument {
  id: string;
  isin: ISIN | null;
  figi: FIGI | null;
  type: InstrumentType;
  assetClass: AssetClass;
  name: string;
  primaryTicker: string;
  primaryExchangeMic: MIC;
  currency: CurrencyCode;
  tickerAliases: TickerAlias[];
  country: string;
  sector: string | null;
  industry: string | null;
  isActive: boolean;
  delistedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Market Data                                                       */
/* ------------------------------------------------------------------ */

export interface OHLCVBar {
  instrumentId: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  trades: number | null;
  barSize: BarSize;
  isAdjusted: boolean;
  source: string;
}

export interface Tick {
  instrumentId: string;
  timestamp: string;
  price: number;
  size: number;
  exchangeMic: MIC;
  conditions: string[];
  tape: string | null;
}

export interface Quote {
  instrumentId: string;
  timestamp: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  bidExchangeMic: MIC;
  askExchangeMic: MIC;
}

/* ------------------------------------------------------------------ */
/*  Fundamentals                                                      */
/* ------------------------------------------------------------------ */

export interface CompanyFundamentals {
  instrumentId: string;
  reportDate: string;
  period: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FY';
  fiscalYear: number;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  epsEstimate: number | null;
  marketCap: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
  freeCashFlow: number | null;
  currency: CurrencyCode;
  source: string;
  updatedAt: string;
}

export interface EarningsEvent {
  instrumentId: string;
  reportDate: string;
  fiscalQuarter: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  surprise: number | null;
  transcriptUrl: string | null;
  source: string;
}

/* ------------------------------------------------------------------ */
/*  Macro                                                             */
/* ------------------------------------------------------------------ */

export interface MacroEvent {
  id: string;
  name: string;
  country: string;
  category: MacroCategory;
  scheduledAt: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unit: string;
  impact: 'high' | 'medium' | 'low';
  source: string;
}

/* ------------------------------------------------------------------ */
/*  News                                                              */
/* ------------------------------------------------------------------ */

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string | null;
  url: string;
  source: string;
  publishedAt: string;
  instrumentIds: string[];
  tickers: string[];
  sentimentScore: number | null;
  sentimentLabel: 'bearish' | 'neutral' | 'bullish' | null;
  categories: string[];
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  WebSocket                                                         */
/* ------------------------------------------------------------------ */

export interface WSEvent<T = unknown> {
  type: WSEventType;
  channel: string;
  timestamp: string;
  sequenceId: number;
  data: T;
}

/* ------------------------------------------------------------------ */
/*  API Envelope                                                      */
/* ------------------------------------------------------------------ */

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
}

/* ------------------------------------------------------------------ */
/*  Auth                                                              */
/* ------------------------------------------------------------------ */

export interface JWTPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

/* ------------------------------------------------------------------ */
/*  Frontend-specific derived types                                   */
/* ------------------------------------------------------------------ */

/** Lightweight quote summary pushed via WebSocket or polled. */
export interface QuoteSummary {
  instrumentId: string;
  ticker: string;
  name: string;
  lastPrice: number;
  previousClose: number;
  change: number;
  changePct: number;
  volume: number;
  high: number;
  low: number;
  updatedAt: string;
}

/** Technical indicator data point returned from analytics API. */
export interface IndicatorPoint {
  timestamp: string;
  value: number;
}

export interface IndicatorSeries {
  name: string;
  params: Record<string, number>;
  data: IndicatorPoint[];
}

/** MACD returns three series. */
export interface MACDPoint {
  timestamp: string;
  macd: number;
  signal: number;
  histogram: number;
}

/** Search results item. */
export interface InstrumentSearchResult {
  id: string;
  primaryTicker: string;
  name: string;
  type: InstrumentType;
  primaryExchangeMic: MIC;
}

/** Sector performance summary. */
export interface SectorPerformance {
  sector: string;
  changePct: number;
  leadingTicker: string;
  leadingChangePct: number;
}

/** Top movers item. */
export interface Mover {
  instrumentId: string;
  ticker: string;
  name: string;
  lastPrice: number;
  changePct: number;
  volume: number;
}

/** Bar params for API requests. */
export interface GetBarsParams {
  instrumentId: string;
  barSize: BarSize;
  start: string;
  end?: string;
  adjusted?: boolean;
  limit?: number;
}

/** Indicator params for API requests. */
export interface GetIndicatorParams {
  instrumentId: string;
  indicator: string;
  barSize: BarSize;
  start: string;
  end?: string;
  params?: Record<string, number>;
}
