/**
 * IEX Cloud Data Adapter
 *
 * Provides access to IEX Cloud API for:
 *  - Real-time and delayed quotes
 *  - Company fundamentals (income statement, balance sheet, cash flow)
 *  - Earnings data
 *
 * API Reference: https://iexcloud.io/docs/
 * REST base:     https://cloud.iexapis.com/stable
 *
 * Authentication is via a `token` query parameter.
 */

import { BaseAdapter, AdapterConfig, AdapterError } from './base-adapter';
import {
  Quote,
  CompanyFundamentals,
  EarningsEvent,
  Instrument,
  InstrumentType,
  AssetClass,
} from '../../../../shared/src/types/instrument';

// ----------------------------------------------------------------
// IEX raw response shapes
// ----------------------------------------------------------------

interface IEXQuoteResponse {
  symbol: string;
  companyName: string;
  primaryExchange: string;
  calculationPrice: string;
  open: number | null;
  openTime: number | null;
  close: number | null;
  closeTime: number | null;
  high: number | null;
  low: number | null;
  latestPrice: number;
  latestSource: string;
  latestTime: string;
  latestUpdate: number;
  latestVolume: number | null;
  iexRealtimePrice: number | null;
  iexRealtimeSize: number | null;
  iexLastUpdated: number | null;
  delayedPrice: number | null;
  delayedPriceTime: number | null;
  oddLotDelayedPrice: number | null;
  oddLotDelayedPriceTime: number | null;
  extendedPrice: number | null;
  extendedChange: number | null;
  extendedChangePercent: number | null;
  extendedPriceTime: number | null;
  previousClose: number;
  previousVolume: number;
  change: number;
  changePercent: number;
  volume: number | null;
  iexMarketPercent: number | null;
  iexVolume: number | null;
  avgTotalVolume: number;
  iexBidPrice: number | null;
  iexBidSize: number | null;
  iexAskPrice: number | null;
  iexAskSize: number | null;
  marketCap: number | null;
  peRatio: number | null;
  week52High: number;
  week52Low: number;
  ytdChange: number;
  lastTradeTime: number;
  isUSMarketOpen: boolean;
  currency: string;
}

interface IEXCompanyResponse {
  symbol: string;
  companyName: string;
  exchange: string;
  industry: string;
  website: string;
  description: string;
  CEO: string;
  securityName: string;
  issueType: string;
  sector: string;
  primarySicCode: number | null;
  employees: number | null;
  tags: string[];
  address: string;
  address2: string | null;
  state: string;
  city: string;
  zip: string;
  country: string;
  phone: string;
}

interface IEXIncomeStatement {
  reportDate: string;
  fiscalDate: string;
  fiscalQuarter: number;
  fiscalYear: number;
  totalRevenue: number | null;
  netIncome: number | null;
  grossProfit: number | null;
  costOfRevenue: number | null;
  operatingExpense: number | null;
  operatingIncome: number | null;
  researchAndDevelopment: number | null;
  currency: string;
}

interface IEXBalanceSheet {
  reportDate: string;
  fiscalDate: string;
  fiscalQuarter: number;
  fiscalYear: number;
  currentAssets: number | null;
  totalAssets: number | null;
  currentDebt: number | null;
  longTermDebt: number | null;
  totalDebt: number | null;
  shareholderEquity: number | null;
  currency: string;
}

interface IEXCashFlow {
  reportDate: string;
  fiscalDate: string;
  fiscalQuarter: number;
  fiscalYear: number;
  capitalExpenditures: number | null;
  cashFlow: number | null; // operating cash flow
  dividendsPaid: number | null;
  currency: string;
}

interface IEXEarningsResult {
  actualEPS: number | null;
  consensusEPS: number | null;
  announceTime: string | null;
  numberOfEstimates: number;
  EPSSurpriseDollar: number | null;
  EPSReportDate: string;
  fiscalPeriod: string;    // e.g. "Q1 2024"
  fiscalEndDate: string;
  yearAgo: number | null;
  yearAgoChangePercent: number | null;
  currency: string;
}

interface IEXStatsResponse {
  marketcap: number | null;
  peRatio: number | null;
  beta: number | null;
  week52high: number | null;
  week52low: number | null;
  dividendYield: number | null;
  ttmEPS: number | null;
  ttmDividendRate: number | null;
  avg30Volume: number | null;
  day200MovingAvg: number | null;
  day50MovingAvg: number | null;
  float: number | null;
  sharesOutstanding: number | null;
  nextEarningsDate: string | null;
  priceToBook: number | null;
  debtToEquity: number | null;
}

// ----------------------------------------------------------------
// Mapping helpers
// ----------------------------------------------------------------

/** Map IEX primary exchange names to MIC codes */
const EXCHANGE_TO_MIC: Record<string, string> = {
  'NEW YORK STOCK EXCHANGE':   'XNYS',
  'NEW YORK STOCK EXCHANGE INC.': 'XNYS',
  'NYSE':                      'XNYS',
  'NASDAQ':                    'XNAS',
  'NASDAQ/NMS (GLOBAL MARKET)':'XNAS',
  'NASDAQ CAPITAL MARKET':     'XNAS',
  'NASDAQ GLOBAL SELECT':      'XNAS',
  'NYSE ARCA':                 'ARCX',
  'NYSE MKT':                  'XASE',
  'CBOE BZX U.S. EQUITIES EXCHANGE': 'BATS',
  'IEX':                       'IEXG',
};

function mapExchangeToMic(exchange: string): string {
  const upper = (exchange || '').toUpperCase();
  return EXCHANGE_TO_MIC[upper] || upper;
}

function mapQuarterLabel(quarter: number): 'Q1' | 'Q2' | 'Q3' | 'Q4' {
  switch (quarter) {
    case 1: return 'Q1';
    case 2: return 'Q2';
    case 3: return 'Q3';
    case 4: return 'Q4';
    default: return 'Q1';
  }
}

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export class IEXAdapter extends BaseAdapter {
  private static readonly BASE_URL = 'https://cloud.iexapis.com/stable';

  constructor(config: AdapterConfig) {
    super({ ...config, providerName: config.providerName ?? 'iex' });
  }

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? IEXAdapter.BASE_URL;
  }

  /**
   * IEX uses a `token` query param instead of a header.
   * We clear the default auth header and inject the token in every request.
   */
  protected getAuthHeaders(): Record<string, string> {
    return {}; // auth is via query param
  }

  /** Inject token query param into every request */
  private withToken(params?: Record<string, string>): Record<string, string> {
    return { ...params, token: this.config.apiKey };
  }

  // -------------------------------------------------------------------
  // Validation hook
  // -------------------------------------------------------------------

  protected validate(raw: unknown): boolean {
    if (raw === null || raw === undefined) {
      this.logger.warn('IEX returned null/undefined response');
      return false;
    }
    // IEX returns a plain string "Unknown symbol" for bad tickers
    if (typeof raw === 'string') {
      this.logger.warn('IEX returned string instead of JSON', { raw });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------
  // fetchQuote
  // -------------------------------------------------------------------

  /**
   * Fetch the latest quote for a ticker.
   *
   * Endpoint: GET /stock/{symbol}/quote
   *
   * Returns a canonical Quote plus additional quote metadata.
   */
  async fetchQuote(
    ticker: string,
    instrumentId: string = '',
  ): Promise<Quote & { latestPrice: number; change: number; changePercent: number; marketCap: number | null }> {
    const response = await this.fetchWithResilience<IEXQuoteResponse>(
      `/stock/${encodeURIComponent(ticker)}/quote`,
      undefined,
      this.withToken(),
    );

    const q = response.data;

    // Validate essential fields
    if (q.latestPrice == null || q.latestPrice <= 0) {
      this.logger.warn('IEX quote has invalid latestPrice', {
        ticker,
        latestPrice: q.latestPrice,
      });
    }

    const bidPrice = q.iexBidPrice ?? q.latestPrice;
    const askPrice = q.iexAskPrice ?? q.latestPrice;
    const bidSize = q.iexBidSize ?? 0;
    const askSize = q.iexAskSize ?? 0;

    // Log unusual spread
    if (askPrice > 0 && bidPrice > 0) {
      const spreadPct = ((askPrice - bidPrice) / bidPrice) * 100;
      if (spreadPct > 5) {
        this.logger.warn('IEX quote has unusually wide spread', {
          ticker,
          bidPrice,
          askPrice,
          spreadPct: spreadPct.toFixed(2),
        });
      }
    }

    return {
      instrumentId,
      timestamp: new Date(q.latestUpdate).toISOString(),
      bidPrice,
      bidSize,
      askPrice,
      askSize,
      bidExchangeMic: 'IEXG',
      askExchangeMic: 'IEXG',
      latestPrice: q.latestPrice,
      change: q.change,
      changePercent: q.changePercent,
      marketCap: q.marketCap,
    };
  }

  // -------------------------------------------------------------------
  // fetchCompanyFundamentals
  // -------------------------------------------------------------------

  /**
   * Fetch company fundamentals by combining income statement, balance sheet,
   * cash flow, and key stats into a single canonical CompanyFundamentals.
   *
   * Endpoints:
   *   GET /stock/{symbol}/income?last=1
   *   GET /stock/{symbol}/balance-sheet?last=1
   *   GET /stock/{symbol}/cash-flow?last=1
   *   GET /stock/{symbol}/stats
   */
  async fetchCompanyFundamentals(
    ticker: string,
    instrumentId: string = '',
  ): Promise<CompanyFundamentals> {
    // Fire all four requests concurrently, respecting rate limiter per-request
    const [incomeRes, balanceRes, cashFlowRes, statsRes] = await Promise.all([
      this.fetchWithResilience<{ income: IEXIncomeStatement[] }>(
        `/stock/${encodeURIComponent(ticker)}/income`,
        undefined,
        this.withToken({ last: '1' }),
      ),
      this.fetchWithResilience<{ balancesheet: IEXBalanceSheet[] }>(
        `/stock/${encodeURIComponent(ticker)}/balance-sheet`,
        undefined,
        this.withToken({ last: '1' }),
      ),
      this.fetchWithResilience<{ cashflow: IEXCashFlow[] }>(
        `/stock/${encodeURIComponent(ticker)}/cash-flow`,
        undefined,
        this.withToken({ last: '1' }),
      ),
      this.fetchWithResilience<IEXStatsResponse>(
        `/stock/${encodeURIComponent(ticker)}/stats`,
        undefined,
        this.withToken(),
      ),
    ]);

    const income = incomeRes.data.income?.[0];
    const balance = balanceRes.data.balancesheet?.[0];
    const cashFlow = cashFlowRes.data.cashflow?.[0];
    const stats = statsRes.data;

    if (!income) {
      this.logger.warn('IEX returned no income statement data', { ticker });
    }

    const now = new Date().toISOString();
    const reportDate = income?.reportDate ?? balance?.reportDate ?? now.slice(0, 10);
    const fiscalYear = income?.fiscalYear ?? balance?.fiscalYear ?? new Date().getFullYear();
    const fiscalQuarter = income?.fiscalQuarter ?? balance?.fiscalQuarter ?? 1;
    const currency = income?.currency ?? balance?.currency ?? 'USD';

    // Compute debt-to-equity from balance sheet if stats don't have it
    let debtToEquity = stats.debtToEquity;
    if (debtToEquity == null && balance) {
      const totalDebt = balance.totalDebt ?? 0;
      const equity = balance.shareholderEquity ?? 0;
      if (equity !== 0) {
        debtToEquity = totalDebt / equity;
      }
    }

    // Compute free cash flow
    let freeCashFlow: number | null = null;
    if (cashFlow) {
      const operatingCF = cashFlow.cashFlow ?? 0;
      const capex = cashFlow.capitalExpenditures ?? 0;
      freeCashFlow = operatingCF - Math.abs(capex);
    }

    // Compute EPS from income if stats don't provide it
    const eps = stats.ttmEPS ?? null;

    return {
      instrumentId,
      reportDate,
      period: mapQuarterLabel(fiscalQuarter),
      fiscalYear,
      revenue: income?.totalRevenue ?? null,
      netIncome: income?.netIncome ?? null,
      eps,
      epsEstimate: null, // IEX doesn't give forward estimates in this endpoint
      marketCap: stats.marketcap ?? null,
      peRatio: stats.peRatio ?? null,
      pbRatio: stats.priceToBook ?? null,
      debtToEquity: debtToEquity ?? null,
      dividendYield: stats.dividendYield ?? null,
      freeCashFlow,
      currency,
      source: 'iex',
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------
  // fetchEarnings
  // -------------------------------------------------------------------

  /**
   * Fetch historical earnings for a ticker.
   *
   * Endpoint: GET /stock/{symbol}/earnings/{last}
   *
   * @param ticker  IEX ticker symbol
   * @param last    Number of quarters to fetch (default 4)
   */
  async fetchEarnings(
    ticker: string,
    instrumentId: string = '',
    last: number = 4,
  ): Promise<EarningsEvent[]> {
    const response = await this.fetchWithResilience<{ earnings: IEXEarningsResult[] }>(
      `/stock/${encodeURIComponent(ticker)}/earnings/${last}`,
      undefined,
      this.withToken(),
    );

    const earnings = response.data.earnings;
    if (!earnings || earnings.length === 0) {
      this.logger.warn('IEX returned no earnings data', { ticker });
      return [];
    }

    return earnings.map((e) => {
      // Compute EPS surprise as percentage
      let surprise: number | null = null;
      if (e.actualEPS != null && e.consensusEPS != null && e.consensusEPS !== 0) {
        surprise = ((e.actualEPS - e.consensusEPS) / Math.abs(e.consensusEPS)) * 100;
      }

      // Log large earnings surprises
      if (surprise != null && Math.abs(surprise) > 50) {
        this.logger.warn('Large earnings surprise detected', {
          ticker,
          period: e.fiscalPeriod,
          actualEPS: e.actualEPS,
          consensusEPS: e.consensusEPS,
          surprisePct: surprise.toFixed(2),
        });
      }

      return {
        instrumentId,
        reportDate: e.EPSReportDate,
        fiscalQuarter: e.fiscalPeriod,
        epsActual: e.actualEPS,
        epsEstimate: e.consensusEPS,
        revenueActual: null, // Not available in IEX earnings endpoint
        revenueEstimate: null,
        surprise,
        transcriptUrl: null,
        source: 'iex',
      };
    });
  }

  // -------------------------------------------------------------------
  // fetchCompanyInfo (helper for instrument resolution)
  // -------------------------------------------------------------------

  /**
   * Fetch basic company info for instrument creation.
   *
   * Endpoint: GET /stock/{symbol}/company
   */
  async fetchCompanyInfo(
    ticker: string,
    instrumentId: string = '',
  ): Promise<Instrument> {
    const response = await this.fetchWithResilience<IEXCompanyResponse>(
      `/stock/${encodeURIComponent(ticker)}/company`,
      undefined,
      this.withToken(),
    );

    const c = response.data;
    const now = new Date().toISOString();

    const issueTypeMap: Record<string, InstrumentType> = {
      cs:  InstrumentType.EQUITY,
      ad:  InstrumentType.EQUITY,
      et:  InstrumentType.ETF,
      ps:  InstrumentType.EQUITY,
      bo:  InstrumentType.BOND,
      su:  InstrumentType.BOND,
      lp:  InstrumentType.EQUITY,
      si:  InstrumentType.INDEX,
    };

    const instrType = issueTypeMap[(c.issueType || 'cs').toLowerCase()] ?? InstrumentType.EQUITY;

    return {
      id: instrumentId || '',
      isin: null,
      figi: null,
      type: instrType,
      assetClass: instrType === InstrumentType.BOND ? AssetClass.FIXED_INCOME : AssetClass.EQUITY,
      name: c.companyName,
      primaryTicker: c.symbol,
      primaryExchangeMic: mapExchangeToMic(c.exchange),
      currency: 'USD',
      tickerAliases: [
        { source: 'iex', ticker: c.symbol },
      ],
      country: (c.country || 'US').slice(0, 2).toUpperCase(),
      sector: c.sector || null,
      industry: c.industry || null,
      isActive: true,
      delistedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.fetchWithResilience<{ status: string }>(
        '/status',
        undefined,
        this.withToken(),
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
