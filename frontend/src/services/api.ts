/**
 * API Client
 *
 * Centralised HTTP client for all backend communication.
 * - Automatic JWT injection
 * - Refresh-token rotation
 * - Structured error handling
 * - Request / response interceptors
 */

import type {
  ApiError,
  CompanyFundamentals,
  EarningsEvent,
  GetBarsParams,
  GetIndicatorParams,
  IndicatorSeries,
  Instrument,
  InstrumentSearchResult,
  MACDPoint,
  MacroEvent,
  Mover,
  NewsArticle,
  OHLCVBar,
  PaginatedResponse,
  QuoteSummary,
  SectorPerformance,
} from '@/types';

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api';

/* ------------------------------------------------------------------ */
/*  Token storage (client-side only)                                  */
/* ------------------------------------------------------------------ */

let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _refreshPromise: Promise<void> | null = null;

export function setTokens(access: string, refresh: string): void {
  _accessToken = access;
  _refreshToken = refresh;
  if (typeof window !== 'undefined') {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
  }
}

export function loadTokens(): void {
  if (typeof window === 'undefined') return;
  _accessToken = localStorage.getItem('access_token');
  _refreshToken = localStorage.getItem('refresh_token');
}

export function clearTokens(): void {
  _accessToken = null;
  _refreshToken = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  }
}

export function getAccessToken(): string | null {
  return _accessToken;
}

/* ------------------------------------------------------------------ */
/*  Error class                                                       */
/* ------------------------------------------------------------------ */

export class ApiClientError extends Error {
  public status: number;
  public code: string;
  public details?: Record<string, unknown>;
  public requestId?: string;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

/* ------------------------------------------------------------------ */
/*  Request helper                                                    */
/* ------------------------------------------------------------------ */

type RequestInterceptor = (init: RequestInit) => RequestInit;
type ResponseInterceptor = (res: Response) => Response | Promise<Response>;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];

export function addRequestInterceptor(fn: RequestInterceptor): void {
  requestInterceptors.push(fn);
}

export function addResponseInterceptor(fn: ResponseInterceptor): void {
  responseInterceptors.push(fn);
}

async function refreshAccessToken(): Promise<void> {
  if (!_refreshToken) {
    clearTokens();
    throw new ApiClientError(401, {
      code: 'AUTH_EXPIRED',
      message: 'No refresh token available',
      requestId: '',
      timestamp: new Date().toISOString(),
    });
  }

  const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: _refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    throw new ApiClientError(res.status, await res.json());
  }

  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let opts: RequestInit = {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      ...(_accessToken ? { Authorization: `Bearer ${_accessToken}` } : {}),
    },
  };

  for (const interceptor of requestInterceptors) {
    opts = interceptor(opts);
  }

  let res = await fetch(`${BASE_URL}${path}`, opts);

  // Token expired — attempt a single refresh then retry
  if (res.status === 401 && _refreshToken) {
    if (!_refreshPromise) {
      _refreshPromise = refreshAccessToken().finally(() => {
        _refreshPromise = null;
      });
    }
    await _refreshPromise;

    // Retry with new token
    opts.headers = {
      ...opts.headers,
      Authorization: `Bearer ${_accessToken}`,
    };
    res = await fetch(`${BASE_URL}${path}`, opts);
  }

  for (const interceptor of responseInterceptors) {
    res = await interceptor(res);
  }

  if (!res.ok) {
    let body: ApiError;
    try {
      body = await res.json();
    } catch {
      body = {
        code: 'UNKNOWN',
        message: res.statusText,
        requestId: '',
        timestamp: new Date().toISOString(),
      };
    }
    throw new ApiClientError(res.status, body);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Query-string builder                                              */
/* ------------------------------------------------------------------ */

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) {
    sp.set(k, String(v));
  }
  return `?${sp.toString()}`;
}

/* ------------------------------------------------------------------ */
/*  API methods                                                       */
/* ------------------------------------------------------------------ */

// ---- Instruments ----

export function getInstruments(params: {
  page?: number;
  pageSize?: number;
  type?: string;
  assetClass?: string;
  country?: string;
  sector?: string;
  isActive?: boolean;
}): Promise<PaginatedResponse<Instrument>> {
  return request(`/v1/instruments${qs(params)}`);
}

export function getInstrument(id: string): Promise<Instrument> {
  return request(`/v1/instruments/${id}`);
}

export function searchInstruments(
  query: string,
  limit = 20,
): Promise<InstrumentSearchResult[]> {
  return request(`/v1/instruments/search${qs({ q: query, limit })}`);
}

// ---- OHLCV Bars ----

export function getBars(params: GetBarsParams): Promise<OHLCVBar[]> {
  const { instrumentId, ...rest } = params;
  return request(`/v1/instruments/${instrumentId}/bars${qs(rest)}`);
}

// ---- Quotes / Summary ----

export function getQuoteSummary(instrumentId: string): Promise<QuoteSummary> {
  return request(`/v1/instruments/${instrumentId}/quote`);
}

export function getQuoteSummaries(instrumentIds: string[]): Promise<QuoteSummary[]> {
  return request(`/v1/quotes/batch${qs({ ids: instrumentIds.join(',') })}`);
}

// ---- Indicators ----

export function getIndicator(params: GetIndicatorParams): Promise<IndicatorSeries> {
  const { instrumentId, indicator, ...rest } = params;
  const queryParams: Record<string, unknown> = { ...rest };
  if (rest.params) {
    queryParams.params = JSON.stringify(rest.params);
  }
  return request(
    `/v1/instruments/${instrumentId}/indicators/${indicator}${qs(queryParams)}`,
  );
}

export function getMACD(
  instrumentId: string,
  barSize: string,
  start: string,
  end?: string,
): Promise<MACDPoint[]> {
  return request(
    `/v1/instruments/${instrumentId}/indicators/macd${qs({ barSize, start, end })}`,
  );
}

// ---- Fundamentals ----

export function getFundamentals(instrumentId: string): Promise<CompanyFundamentals> {
  return request(`/v1/instruments/${instrumentId}/fundamentals`);
}

export function getEarnings(
  instrumentId: string,
  limit = 8,
): Promise<EarningsEvent[]> {
  return request(`/v1/instruments/${instrumentId}/earnings${qs({ limit })}`);
}

// ---- News ----

export function getNews(params: {
  page?: number;
  pageSize?: number;
  instrumentId?: string;
  sentiment?: string;
  from?: string;
  to?: string;
}): Promise<PaginatedResponse<NewsArticle>> {
  return request(`/v1/news${qs(params)}`);
}

export function getNewsArticle(id: string): Promise<NewsArticle> {
  return request(`/v1/news/${id}`);
}

// ---- Macro Calendar ----

export function getCalendar(params: {
  from?: string;
  to?: string;
  country?: string;
  category?: string;
  impact?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<MacroEvent>> {
  return request(`/v1/calendar${qs(params)}`);
}

// ---- Market Overview ----

export function getTopMovers(params: {
  direction?: 'gainers' | 'losers';
  limit?: number;
}): Promise<Mover[]> {
  return request(`/v1/market/movers${qs(params)}`);
}

export function getSectorPerformance(): Promise<SectorPerformance[]> {
  return request('/v1/market/sectors');
}

export function getIndices(): Promise<QuoteSummary[]> {
  return request('/v1/market/indices');
}

// ---- Auth ----

export function login(email: string, password: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  return request('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  const promise = request<void>('/v1/auth/logout', { method: 'POST' });
  clearTokens();
  return promise;
}
