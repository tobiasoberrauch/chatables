/**
 * Polygon.io Data Adapter
 *
 * Provides access to Polygon.io REST and WebSocket APIs for:
 *  - Historical OHLCV bars (aggregates)
 *  - Real-time tick streaming via WebSocket
 *  - Instrument / ticker details
 *
 * API Reference: https://polygon.io/docs
 *
 * REST base:  https://api.polygon.io
 * WS base:    wss://socket.polygon.io
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { BaseAdapter, AdapterConfig, AdapterResponse, AdapterError } from './base-adapter';
import {
  OHLCVBar,
  BarSize,
  Tick,
  Instrument,
  InstrumentType,
  AssetClass,
} from '../../../../shared/src/types/instrument';
import { Logger } from '../../../../shared/src/utils/logger';

// ----------------------------------------------------------------
// Polygon-specific raw response shapes
// ----------------------------------------------------------------

interface PolygonAggregateResult {
  v: number;   // volume
  vw: number;  // VWAP
  o: number;   // open
  c: number;   // close
  h: number;   // high
  l: number;   // low
  t: number;   // Unix epoch ms (bar start)
  n: number;   // number of trades
}

interface PolygonAggregatesResponse {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results: PolygonAggregateResult[];
  status: string;
  request_id: string;
  next_url?: string;
}

interface PolygonTickerDetailsResponse {
  status: string;
  request_id: string;
  results: {
    ticker: string;
    name: string;
    market: string;
    locale: string;
    primary_exchange: string;
    type: string;
    active: boolean;
    currency_name: string;
    cik: string;
    composite_figi: string;
    share_class_figi: string;
    sic_code: string;
    sic_description: string;
    ticker_root: string;
    delisted_utc?: string;
    list_date?: string;
  };
}

interface PolygonWSTradeMessage {
  ev: string;   // event type: "T" = trade, "Q" = quote
  sym: string;  // ticker
  p: number;    // price
  s: number;    // size
  x: number;    // exchange ID
  c: number[];  // condition codes
  t: number;    // SIP timestamp (ns or ms depending on feed)
  z: number;    // tape (1=A, 2=B, 3=C)
}

// ----------------------------------------------------------------
// Mapping tables
// ----------------------------------------------------------------

const POLYGON_TIMESPAN_MAP: Record<string, { multiplier: number; timespan: string }> = {
  '1m':  { multiplier: 1,  timespan: 'minute' },
  '5m':  { multiplier: 5,  timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '30m': { multiplier: 30, timespan: 'minute' },
  '1h':  { multiplier: 1,  timespan: 'hour' },
  '4h':  { multiplier: 4,  timespan: 'hour' },
  '1d':  { multiplier: 1,  timespan: 'day' },
  '1w':  { multiplier: 1,  timespan: 'week' },
  '1M':  { multiplier: 1,  timespan: 'month' },
};

/** Map Polygon exchange IDs to MIC codes (common US exchanges) */
const EXCHANGE_ID_TO_MIC: Record<number, string> = {
  1:  'XASE',  // NYSE American
  2:  'XNAS',  // NASDAQ
  4:  'XNYS',  // NYSE
  10: 'IEXG',  // IEX
  11: 'XCHI',  // CHX
  12: 'XPHL',  // PHLX
  15: 'ARCX',  // NYSE Arca
  17: 'XCBO',  // CBOE
  19: 'XBOS',  // NASDAQ BX
  21: 'EDGA',  // EDGA
  22: 'EDGX',  // EDGX
};

/** Map Polygon tape IDs to SIP tape letters */
const TAPE_MAP: Record<number, string> = {
  1: 'A',
  2: 'B',
  3: 'C',
};

/** Map Polygon type strings to InstrumentType */
const TYPE_MAP: Record<string, InstrumentType> = {
  CS:    InstrumentType.EQUITY,
  PFD:   InstrumentType.EQUITY,
  ETF:   InstrumentType.ETF,
  ETN:   InstrumentType.ETF,
  ADRC:  InstrumentType.EQUITY,
  RIGHT: InstrumentType.EQUITY,
  BOND:  InstrumentType.BOND,
  FX:    InstrumentType.FX,
  CRYPTO:InstrumentType.CRYPTO,
  IDX:   InstrumentType.INDEX,
};

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export interface PolygonAdapterConfig extends AdapterConfig {
  /** Override WebSocket URL (default: wss://socket.polygon.io) */
  wsBaseUrl?: string;
}

export class PolygonAdapter extends BaseAdapter {
  private static readonly REST_BASE = 'https://api.polygon.io';
  private static readonly WS_BASE = 'wss://socket.polygon.io/stocks';

  private readonly wsBaseUrl: string;
  private ws: WebSocket | null = null;
  private readonly tickEmitter = new EventEmitter();
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedTickers = new Set<string>();
  private wsAuthenticated = false;
  private readonly wsLogger: Logger;

  constructor(config: PolygonAdapterConfig) {
    super({ ...config, providerName: config.providerName ?? 'polygon' });
    this.wsBaseUrl = config.wsBaseUrl ?? PolygonAdapter.WS_BASE;
    this.wsLogger = new Logger('adapter:polygon:ws');
  }

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? PolygonAdapter.REST_BASE;
  }

  /**
   * Auth for Polygon REST is via query parameter `apiKey`.
   * We do NOT send a Bearer header.
   */
  protected getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  // -------------------------------------------------------------------
  // Validation hook
  // -------------------------------------------------------------------

  protected validate(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn('Polygon response is not an object', { raw });
      return false;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.status === 'ERROR') {
      this.logger.warn('Polygon returned error status', { raw });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------
  // fetchHistoricalBars
  // -------------------------------------------------------------------

  /**
   * Fetch historical OHLCV bars for a ticker over a date range.
   *
   * Uses Polygon's Aggregates (Bars) endpoint:
   *   GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
   *
   * Automatically paginates through `next_url` when the response is paginated.
   *
   * @param ticker        Polygon ticker symbol (e.g. "AAPL")
   * @param from          Start date, YYYY-MM-DD
   * @param to            End date, YYYY-MM-DD
   * @param barSize       Canonical bar size (default: '1d')
   * @param adjusted      Apply split/dividend adjustments (default: true)
   * @param instrumentId  Canonical instrument UUID to tag the bars with
   */
  async fetchHistoricalBars(
    ticker: string,
    from: string,
    to: string,
    barSize: BarSize = BarSize.DAY_1,
    adjusted: boolean = true,
    instrumentId: string = '',
  ): Promise<OHLCVBar[]> {
    const timespanConfig = POLYGON_TIMESPAN_MAP[barSize];
    if (!timespanConfig) {
      throw new AdapterError('polygon', `Unsupported bar size: ${barSize}`);
    }

    const allBars: OHLCVBar[] = [];
    let currentUrl: string | null = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${timespanConfig.multiplier}/${timespanConfig.timespan}/${from}/${to}`;
    let queryParams: Record<string, string> | undefined = {
      adjusted: adjusted ? 'true' : 'false',
      sort: 'asc',
      limit: '50000',
    };

    while (currentUrl) {
      this.logger.info('Fetching Polygon aggregates page', {
        ticker,
        url: currentUrl,
        barCount: allBars.length,
      });

      let response: AdapterResponse<PolygonAggregatesResponse>;

      if (currentUrl.startsWith('http')) {
        // Paginated next_url is an absolute URL — fetch directly
        response = await this.fetchWithResilience<PolygonAggregatesResponse>(
          currentUrl,
          undefined,
          undefined,
        );
      } else {
        response = await this.fetchWithResilience<PolygonAggregatesResponse>(
          currentUrl,
          undefined,
          queryParams,
        );
      }

      const body = response.data;

      if (body.results && body.results.length > 0) {
        for (const bar of body.results) {
          const normalized = this.normalizeBar(bar, instrumentId, barSize, adjusted);
          if (normalized) {
            allBars.push(normalized);
          }
        }
      }

      // Handle pagination
      if (body.next_url) {
        // Polygon's next_url already contains apiKey, so fetch it as-is
        currentUrl = body.next_url;
        queryParams = undefined; // next_url is fully qualified
      } else {
        currentUrl = null;
      }
    }

    this.logger.info('Fetched Polygon aggregates', {
      ticker,
      from,
      to,
      barSize,
      barCount: allBars.length,
    });

    return allBars;
  }

  private normalizeBar(
    raw: PolygonAggregateResult,
    instrumentId: string,
    barSize: BarSize,
    adjusted: boolean,
  ): OHLCVBar | null {
    // Sanity checks — log and skip corrupted bars
    if (raw.h < raw.l) {
      this.logger.warn('Polygon bar has high < low, skipping', {
        timestamp: raw.t,
        high: raw.h,
        low: raw.l,
      });
      return null;
    }

    if (raw.v < 0) {
      this.logger.warn('Polygon bar has negative volume, clamping to 0', {
        timestamp: raw.t,
        volume: raw.v,
      });
      raw.v = 0;
    }

    return {
      instrumentId,
      timestamp: new Date(raw.t).toISOString(),
      open: raw.o,
      high: raw.h,
      low: raw.l,
      close: raw.c,
      volume: raw.v,
      vwap: raw.vw ?? null,
      trades: raw.n ?? null,
      barSize,
      isAdjusted: adjusted,
      source: 'polygon',
    };
  }

  // -------------------------------------------------------------------
  // fetchInstrumentDetails
  // -------------------------------------------------------------------

  /**
   * Fetch detailed ticker information from Polygon.
   *
   * Uses Ticker Details v3:
   *   GET /v3/reference/tickers/{ticker}
   */
  async fetchInstrumentDetails(
    ticker: string,
    instrumentId: string = '',
  ): Promise<Instrument> {
    const response = await this.fetchWithResilience<PolygonTickerDetailsResponse>(
      `/v3/reference/tickers/${encodeURIComponent(ticker)}`,
    );

    const r = response.data.results;

    const instrType = TYPE_MAP[r.type] ?? InstrumentType.EQUITY;
    let assetClass: AssetClass;
    switch (instrType) {
      case InstrumentType.FX:     assetClass = AssetClass.FX; break;
      case InstrumentType.CRYPTO: assetClass = AssetClass.CRYPTO; break;
      case InstrumentType.BOND:   assetClass = AssetClass.FIXED_INCOME; break;
      default:                    assetClass = AssetClass.EQUITY; break;
    }

    const now = new Date().toISOString();

    return {
      id: instrumentId || '',
      isin: null,
      figi: r.composite_figi || null,
      type: instrType,
      assetClass,
      name: r.name,
      primaryTicker: r.ticker,
      primaryExchangeMic: r.primary_exchange || '',
      currency: (r.currency_name || 'USD').toUpperCase(),
      tickerAliases: [
        { source: 'polygon', ticker: r.ticker },
      ],
      country: r.locale === 'us' ? 'US' : r.locale?.toUpperCase() || '',
      sector: r.sic_description || null,
      industry: null,
      isActive: r.active,
      delistedAt: r.delisted_utc || null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------
  // streamTicks (WebSocket)
  // -------------------------------------------------------------------

  /**
   * Open a WebSocket connection to Polygon's real-time trades feed and
   * stream ticks for the given tickers.
   *
   * Returns an EventEmitter that emits:
   *   'tick'  — normalised Tick object
   *   'error' — Error object
   *   'close' — void (connection closed)
   *
   * WS endpoint: wss://socket.polygon.io/stocks
   * Auth message: {"action":"auth","params":"<API_KEY>"}
   * Subscribe:    {"action":"subscribe","params":"T.AAPL,T.MSFT"}
   */
  streamTicks(
    tickers: string[],
    instrumentIdMap: Record<string, string> = {},
  ): EventEmitter {
    this.subscribedTickers = new Set(tickers);
    this.connectWebSocket(instrumentIdMap);
    return this.tickEmitter;
  }

  private connectWebSocket(instrumentIdMap: Record<string, string>): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this.wsAuthenticated = false;
    const url = this.wsBaseUrl;

    this.wsLogger.info('Connecting to Polygon WebSocket', { url });
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.wsLogger.info('WebSocket connected, authenticating');
      this.ws!.send(JSON.stringify({ action: 'auth', params: this.config.apiKey }));
    });

    this.ws.on('message', (rawData: WebSocket.Data) => {
      try {
        const messages = JSON.parse(rawData.toString());

        // Polygon sends arrays of messages
        const msgArray: PolygonWSMessage[] = Array.isArray(messages) ? messages : [messages];

        for (const msg of msgArray) {
          this.handleWSMessage(msg, instrumentIdMap);
        }
      } catch (err) {
        this.wsLogger.warn('Failed to parse WebSocket message', {
          error: (err as Error).message,
        });
      }
    });

    this.ws.on('error', (err: Error) => {
      this.wsLogger.error('WebSocket error', err);
      this.tickEmitter.emit('error', err);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.wsLogger.warn('WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      this.tickEmitter.emit('close');
      this.scheduleReconnect(instrumentIdMap);
    });
  }

  private handleWSMessage(
    msg: PolygonWSMessage,
    instrumentIdMap: Record<string, string>,
  ): void {
    // Auth response
    if (msg.ev === 'status') {
      if (msg.status === 'auth_success') {
        this.wsAuthenticated = true;
        this.wsLogger.info('WebSocket authenticated');
        // Subscribe to tickers
        const params = Array.from(this.subscribedTickers)
          .map((t) => `T.${t}`)
          .join(',');
        this.ws!.send(JSON.stringify({ action: 'subscribe', params }));
        this.wsLogger.info('Subscribed to tickers', { count: this.subscribedTickers.size });
      } else if (msg.status === 'auth_failed') {
        this.wsLogger.error('WebSocket authentication failed', new Error('auth_failed'));
        this.tickEmitter.emit('error', new Error('Polygon WebSocket auth failed'));
      }
      return;
    }

    // Trade message
    if (msg.ev === 'T') {
      const trade = msg as unknown as PolygonWSTradeMessage;
      const tick = this.normalizeTick(trade, instrumentIdMap);
      if (tick) {
        this.tickEmitter.emit('tick', tick);
      }
    }
  }

  private normalizeTick(
    raw: PolygonWSTradeMessage,
    instrumentIdMap: Record<string, string>,
  ): Tick | null {
    if (raw.p <= 0) {
      this.wsLogger.warn('Tick with non-positive price, skipping', {
        ticker: raw.sym,
        price: raw.p,
      });
      return null;
    }

    return {
      instrumentId: instrumentIdMap[raw.sym] || '',
      timestamp: new Date(raw.t).toISOString(),
      price: raw.p,
      size: raw.s,
      exchangeMic: EXCHANGE_ID_TO_MIC[raw.x] || `POLY-${raw.x}`,
      conditions: (raw.c || []).map(String),
      tape: TAPE_MAP[raw.z] || null,
    };
  }

  private scheduleReconnect(instrumentIdMap: Record<string, string>): void {
    if (this.wsReconnectTimer) return;

    const delayMs = 5000 + Math.random() * 5000; // 5-10s jittered
    this.wsLogger.info('Scheduling WebSocket reconnect', { delayMs: Math.round(delayMs) });

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.subscribedTickers.size > 0) {
        this.connectWebSocket(instrumentIdMap);
      }
    }, delayMs);
  }

  /**
   * Unsubscribe from all tickers and close the WebSocket connection.
   */
  stopStreaming(): void {
    this.subscribedTickers.clear();
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.wsLogger.info('Streaming stopped');
  }

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.fetchWithResilience<{ status: string }>(
        '/v1/marketstatus/now',
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ----------------------------------------------------------------
// Internal types for WS message parsing
// ----------------------------------------------------------------

interface PolygonWSMessage {
  ev: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}
