/**
 * Canonical Financial Instrument Schema
 *
 * All external data sources normalize into these types before storage or consumption.
 * This is the single source of truth for instrument representation across the system.
 */

/** ISO 10383 Market Identifier Code */
export type MIC = string;

/** ISO 4217 Currency Code */
export type CurrencyCode = string;

/** ISO 6166 International Securities Identification Number */
export type ISIN = string;

/** Financial Instrument Global Identifier (Bloomberg Open Symbology) */
export type FIGI = string;

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

export interface TickerAlias {
  source: string;       // e.g. 'polygon', 'iex', 'alphaVantage'
  ticker: string;       // source-specific ticker symbol
  exchangeMic?: MIC;    // exchange where this alias is valid
}

export interface Instrument {
  id: string;                    // Internal UUID v7 (time-sortable)
  isin: ISIN | null;            // Null for FX pairs, some crypto
  figi: FIGI | null;            // Bloomberg FIGI when available
  type: InstrumentType;
  assetClass: AssetClass;
  name: string;                  // Full legal name
  primaryTicker: string;         // Primary display ticker (e.g. "AAPL")
  primaryExchangeMic: MIC;       // Primary listing exchange MIC
  currency: CurrencyCode;        // Denomination currency
  tickerAliases: TickerAlias[];  // All known aliases across sources
  country: string;               // ISO 3166-1 alpha-2
  sector: string | null;         // GICS sector
  industry: string | null;       // GICS industry
  isActive: boolean;             // Trading status
  delistedAt: string | null;     // ISO 8601 timestamp if delisted
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}

/** FX-specific instrument extension */
export interface FxInstrument extends Instrument {
  type: InstrumentType.FX;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
}

/** Corporate action types that affect price series */
export enum CorporateActionType {
  SPLIT = 'SPLIT',
  REVERSE_SPLIT = 'REVERSE_SPLIT',
  DIVIDEND = 'DIVIDEND',
  SPECIAL_DIVIDEND = 'SPECIAL_DIVIDEND',
  SPINOFF = 'SPINOFF',
  MERGER = 'MERGER',
  RIGHTS_ISSUE = 'RIGHTS_ISSUE',
  NAME_CHANGE = 'NAME_CHANGE',
  TICKER_CHANGE = 'TICKER_CHANGE',
}

export interface CorporateAction {
  id: string;
  instrumentId: string;
  type: CorporateActionType;
  exDate: string;                // ISO 8601 date
  recordDate: string | null;
  paymentDate: string | null;
  ratio: number | null;          // Split ratio (e.g., 4 for 4:1 split)
  amount: number | null;         // Dividend amount per share
  currency: CurrencyCode | null;
  description: string;
  source: string;
  createdAt: string;
}

/** OHLCV bar — the core time-series record */
export interface OHLCVBar {
  instrumentId: string;
  timestamp: string;             // ISO 8601 UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  trades: number | null;         // Number of trades in bar
  barSize: BarSize;
  isAdjusted: boolean;           // Whether corporate actions are applied
  source: string;
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

/** Real-time tick from streaming feeds */
export interface Tick {
  instrumentId: string;
  timestamp: string;             // ISO 8601 UTC with microsecond precision
  price: number;
  size: number;
  exchangeMic: MIC;
  conditions: string[];          // Trade condition codes
  tape: string | null;           // SIP tape (A/B/C for US equities)
}

/** Level 2 quote */
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

/** Company fundamentals */
export interface CompanyFundamentals {
  instrumentId: string;
  reportDate: string;            // ISO 8601 date
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

/** Earnings event */
export interface EarningsEvent {
  instrumentId: string;
  reportDate: string;
  fiscalQuarter: string;         // e.g. "Q1 2025"
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  surprise: number | null;       // EPS surprise percentage
  transcriptUrl: string | null;
  source: string;
}

/** Macroeconomic event */
export interface MacroEvent {
  id: string;
  name: string;                  // e.g. "US Non-Farm Payrolls"
  country: string;               // ISO 3166-1 alpha-2
  category: MacroCategory;
  scheduledAt: string;           // ISO 8601 UTC
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unit: string;                  // e.g. "K", "%", "index"
  impact: 'high' | 'medium' | 'low';
  source: string;
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

/** News article with metadata */
export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string | null;        // Full text when available
  url: string;
  source: string;                // Publisher name
  publishedAt: string;           // ISO 8601 UTC
  instrumentIds: string[];       // Related instruments
  tickers: string[];             // Mentioned tickers
  sentimentScore: number | null; // -1.0 to 1.0 (bearish to bullish)
  sentimentLabel: 'bearish' | 'neutral' | 'bullish' | null;
  categories: string[];
  createdAt: string;
}

/** WebSocket event envelope */
export interface WSEvent<T = unknown> {
  type: WSEventType;
  channel: string;               // e.g. "ticks.AAPL", "news.all"
  timestamp: string;
  sequenceId: number;
  data: T;
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

/** API pagination */
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

/** API error response */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
}

/** User roles for RBAC */
export enum UserRole {
  VIEWER = 'viewer',
  ANALYST = 'analyst',
  ADMIN = 'admin',
}

export interface JWTPayload {
  sub: string;          // User ID
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}
