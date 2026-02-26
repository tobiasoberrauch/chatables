/**
 * Federal Reserve FRED Data Adapter
 *
 * Provides access to the FRED (Federal Reserve Economic Data) API for:
 *  - Economic data series (GDP, CPI, unemployment, yields, etc.)
 *  - Release calendar / macro event scheduling
 *
 * API Reference: https://fred.stlouisfed.org/docs/api/fred/
 * REST base:     https://api.stlouisfed.org/fred
 *
 * Authentication is via an `api_key` query parameter.
 * Rate limit: 120 requests/minute.
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseAdapter, AdapterConfig, AdapterError } from './base-adapter';
import {
  MacroEvent,
  MacroCategory,
  OHLCVBar,
  BarSize,
} from '../../../../shared/src/types/instrument';

// ----------------------------------------------------------------
// FRED raw response shapes
// ----------------------------------------------------------------

interface FREDObservation {
  realtime_start: string;
  realtime_end: string;
  date: string;
  value: string; // "." means missing
}

interface FREDSeriesObservationsResponse {
  realtime_start: string;
  realtime_end: string;
  observation_start: string;
  observation_end: string;
  units: string;
  output_type: number;
  file_type: string;
  order_by: string;
  sort_order: string;
  count: number;
  offset: number;
  limit: number;
  observations: FREDObservation[];
}

interface FREDSeriesInfo {
  id: string;
  realtime_start: string;
  realtime_end: string;
  title: string;
  observation_start: string;
  observation_end: string;
  frequency: string;
  frequency_short: string;
  units: string;
  units_short: string;
  seasonal_adjustment: string;
  seasonal_adjustment_short: string;
  last_updated: string;
  popularity: number;
  notes: string;
}

interface FREDSeriesResponse {
  seriess: FREDSeriesInfo[];
}

interface FREDRelease {
  id: number;
  realtime_start: string;
  realtime_end: string;
  name: string;
  press_release: boolean;
  link: string | null;
  notes: string | null;
}

interface FREDReleaseDate {
  release_id: number;
  release_name: string;
  date: string;
}

interface FREDReleaseDatesResponse {
  realtime_start: string;
  realtime_end: string;
  order_by: string;
  sort_order: string;
  count: number;
  offset: number;
  limit: number;
  release_dates: FREDReleaseDate[];
}

interface FREDReleasesResponse {
  realtime_start: string;
  realtime_end: string;
  order_by: string;
  sort_order: string;
  count: number;
  offset: number;
  limit: number;
  releases: FREDRelease[];
}

// ----------------------------------------------------------------
// FRED series to canonical mapping
// ----------------------------------------------------------------

interface SeriesMeta {
  category: MacroCategory;
  name: string;
  unit: string;
  impact: 'high' | 'medium' | 'low';
  country: string;
}

/**
 * Mapping of well-known FRED series IDs to canonical metadata.
 * This covers the most commonly tracked macroeconomic indicators.
 */
const SERIES_META: Record<string, SeriesMeta> = {
  // GDP
  'GDP':         { category: MacroCategory.GDP, name: 'US Gross Domestic Product', unit: 'B$', impact: 'high', country: 'US' },
  'GDPC1':       { category: MacroCategory.GDP, name: 'US Real GDP', unit: 'B$', impact: 'high', country: 'US' },
  'A191RL1Q225SBEA': { category: MacroCategory.GDP, name: 'US Real GDP Growth Rate', unit: '%', impact: 'high', country: 'US' },

  // Employment
  'UNRATE':      { category: MacroCategory.EMPLOYMENT, name: 'US Unemployment Rate', unit: '%', impact: 'high', country: 'US' },
  'PAYEMS':      { category: MacroCategory.EMPLOYMENT, name: 'US Non-Farm Payrolls', unit: 'K', impact: 'high', country: 'US' },
  'ICSA':        { category: MacroCategory.EMPLOYMENT, name: 'US Initial Jobless Claims', unit: 'K', impact: 'medium', country: 'US' },
  'CIVPART':     { category: MacroCategory.EMPLOYMENT, name: 'US Labor Force Participation Rate', unit: '%', impact: 'medium', country: 'US' },

  // Inflation
  'CPIAUCSL':    { category: MacroCategory.INFLATION, name: 'US CPI (All Urban Consumers)', unit: 'index', impact: 'high', country: 'US' },
  'CPILFESL':    { category: MacroCategory.INFLATION, name: 'US Core CPI (Ex Food & Energy)', unit: 'index', impact: 'high', country: 'US' },
  'PCEPI':       { category: MacroCategory.INFLATION, name: 'US PCE Price Index', unit: 'index', impact: 'high', country: 'US' },
  'PCEPILFE':    { category: MacroCategory.INFLATION, name: 'US Core PCE Price Index', unit: 'index', impact: 'high', country: 'US' },
  'T5YIE':       { category: MacroCategory.INFLATION, name: 'US 5-Year Breakeven Inflation Rate', unit: '%', impact: 'medium', country: 'US' },

  // Central Bank / Rates
  'FEDFUNDS':    { category: MacroCategory.CENTRAL_BANK, name: 'Federal Funds Effective Rate', unit: '%', impact: 'high', country: 'US' },
  'DFF':         { category: MacroCategory.CENTRAL_BANK, name: 'Federal Funds Rate (Daily)', unit: '%', impact: 'high', country: 'US' },
  'DGS2':        { category: MacroCategory.CENTRAL_BANK, name: 'US 2-Year Treasury Yield', unit: '%', impact: 'high', country: 'US' },
  'DGS10':       { category: MacroCategory.CENTRAL_BANK, name: 'US 10-Year Treasury Yield', unit: '%', impact: 'high', country: 'US' },
  'DGS30':       { category: MacroCategory.CENTRAL_BANK, name: 'US 30-Year Treasury Yield', unit: '%', impact: 'medium', country: 'US' },
  'T10Y2Y':      { category: MacroCategory.CENTRAL_BANK, name: 'US 10Y-2Y Yield Spread', unit: '%', impact: 'high', country: 'US' },
  'WALCL':       { category: MacroCategory.CENTRAL_BANK, name: 'Fed Total Assets (Balance Sheet)', unit: 'M$', impact: 'medium', country: 'US' },

  // Housing
  'HOUST':       { category: MacroCategory.HOUSING, name: 'US Housing Starts', unit: 'K', impact: 'medium', country: 'US' },
  'CSUSHPISA':   { category: MacroCategory.HOUSING, name: 'Case-Shiller Home Price Index', unit: 'index', impact: 'medium', country: 'US' },
  'MORTGAGE30US':{ category: MacroCategory.HOUSING, name: 'US 30-Year Fixed Mortgage Rate', unit: '%', impact: 'medium', country: 'US' },

  // Manufacturing
  'MANEMP':      { category: MacroCategory.MANUFACTURING, name: 'US Manufacturing Employment', unit: 'K', impact: 'low', country: 'US' },
  'INDPRO':      { category: MacroCategory.MANUFACTURING, name: 'US Industrial Production Index', unit: 'index', impact: 'medium', country: 'US' },
  'DGORDER':     { category: MacroCategory.MANUFACTURING, name: 'US Durable Goods Orders', unit: 'M$', impact: 'medium', country: 'US' },

  // Consumer
  'RSAFS':       { category: MacroCategory.CONSUMER, name: 'US Retail Sales', unit: 'M$', impact: 'medium', country: 'US' },
  'UMCSENT':     { category: MacroCategory.CONSUMER, name: 'U of Michigan Consumer Sentiment', unit: 'index', impact: 'medium', country: 'US' },
  'PCE':         { category: MacroCategory.CONSUMER, name: 'US Personal Consumption Expenditures', unit: 'B$', impact: 'medium', country: 'US' },

  // Trade
  'BOPGSTB':     { category: MacroCategory.TRADE, name: 'US Trade Balance', unit: 'M$', impact: 'medium', country: 'US' },
};

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export class FREDAdapter extends BaseAdapter {
  private static readonly BASE_URL = 'https://api.stlouisfed.org/fred';

  constructor(config: AdapterConfig) {
    super({ ...config, providerName: config.providerName ?? 'fred' });
  }

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? FREDAdapter.BASE_URL;
  }

  /** FRED uses query param auth — no headers */
  protected getAuthHeaders(): Record<string, string> {
    return {};
  }

  /** Inject API key and JSON format into every request */
  private withAuth(params: Record<string, string>): Record<string, string> {
    return {
      ...params,
      api_key: this.config.apiKey,
      file_type: 'json',
    };
  }

  // -------------------------------------------------------------------
  // Validation hook
  // -------------------------------------------------------------------

  protected validate(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn('FRED returned non-object response');
      return false;
    }

    const obj = raw as Record<string, unknown>;

    // FRED returns an error_code and error_message on failure
    if (obj.error_code !== undefined) {
      this.logger.warn('FRED API error', {
        errorCode: obj.error_code,
        errorMessage: obj.error_message,
      });
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------
  // fetchSeries
  // -------------------------------------------------------------------

  /**
   * Fetch observation data for a FRED series, normalised into MacroEvent[].
   *
   * Endpoint: GET /series/observations?series_id={id}&observation_start={start}&observation_end={end}
   *
   * @param seriesId          FRED series ID (e.g. "UNRATE", "DGS10")
   * @param observationStart  Start date YYYY-MM-DD (default: 5 years ago)
   * @param observationEnd    End date YYYY-MM-DD (default: today)
   * @param limit             Max observations to return (default: 10000)
   */
  async fetchSeries(
    seriesId: string,
    observationStart?: string,
    observationEnd?: string,
    limit: number = 10000,
  ): Promise<MacroEvent[]> {
    const effectiveStart = observationStart ?? this.yearsAgo(5);
    const effectiveEnd = observationEnd ?? this.today();

    // First get series metadata if we don't have it cached
    const meta = SERIES_META[seriesId] ?? await this.fetchSeriesMeta(seriesId);

    const allObservations: FREDObservation[] = [];
    let offset = 0;
    const pageLimit = Math.min(limit, 10000);

    // FRED paginates at 10,000 observations max per request
    while (true) {
      const response = await this.fetchWithResilience<FREDSeriesObservationsResponse>(
        '/series/observations',
        undefined,
        this.withAuth({
          series_id: seriesId,
          observation_start: effectiveStart,
          observation_end: effectiveEnd,
          sort_order: 'asc',
          limit: String(pageLimit),
          offset: String(offset),
        }),
      );

      const obs = response.data.observations;
      if (!obs || obs.length === 0) break;

      allObservations.push(...obs);

      if (obs.length < pageLimit || allObservations.length >= limit) break;
      offset += obs.length;
    }

    // Convert to MacroEvent
    const events: MacroEvent[] = [];
    let previousValue: number | null = null;

    for (const obs of allObservations) {
      // FRED uses "." for missing values
      if (obs.value === '.') {
        this.logger.debug('FRED observation is missing, skipping', {
          seriesId,
          date: obs.date,
        });
        continue;
      }

      const value = parseFloat(obs.value);
      if (isNaN(value)) {
        this.logger.warn('FRED observation has unparseable value', {
          seriesId,
          date: obs.date,
          rawValue: obs.value,
        });
        continue;
      }

      events.push({
        id: `fred-${seriesId}-${obs.date}`,
        name: meta.name,
        country: meta.country,
        category: meta.category,
        scheduledAt: new Date(obs.date + 'T00:00:00Z').toISOString(),
        actual: value,
        forecast: null, // FRED doesn't provide forecasts
        previous: previousValue,
        unit: meta.unit,
        impact: meta.impact,
        source: 'fred',
      });

      previousValue = value;
    }

    this.logger.info('Fetched FRED series', {
      seriesId,
      observationCount: events.length,
      start: effectiveStart,
      end: effectiveEnd,
    });

    return events;
  }

  // -------------------------------------------------------------------
  // fetchSeriesAsTimeSeries
  // -------------------------------------------------------------------

  /**
   * Fetch a FRED series as OHLCV bars (using value as all of O/H/L/C).
   * Useful for charting economic indicators alongside price data.
   */
  async fetchSeriesAsTimeSeries(
    seriesId: string,
    instrumentId: string = '',
    observationStart?: string,
    observationEnd?: string,
  ): Promise<OHLCVBar[]> {
    const effectiveStart = observationStart ?? this.yearsAgo(5);
    const effectiveEnd = observationEnd ?? this.today();

    const response = await this.fetchWithResilience<FREDSeriesObservationsResponse>(
      '/series/observations',
      undefined,
      this.withAuth({
        series_id: seriesId,
        observation_start: effectiveStart,
        observation_end: effectiveEnd,
        sort_order: 'asc',
        limit: '100000',
      }),
    );

    const bars: OHLCVBar[] = [];

    for (const obs of response.data.observations) {
      if (obs.value === '.') continue;

      const value = parseFloat(obs.value);
      if (isNaN(value)) continue;

      bars.push({
        instrumentId,
        timestamp: new Date(obs.date + 'T00:00:00Z').toISOString(),
        open: value,
        high: value,
        low: value,
        close: value,
        volume: 0,
        vwap: null,
        trades: null,
        barSize: BarSize.DAY_1,
        isAdjusted: false,
        source: 'fred',
      });
    }

    return bars;
  }

  // -------------------------------------------------------------------
  // fetchMacroCalendar
  // -------------------------------------------------------------------

  /**
   * Fetch upcoming FRED release dates (economic calendar).
   *
   * Endpoint: GET /releases/dates?include_release_dates_with_no_data=true
   *
   * Returns release dates for the next 30 days, then maps each to a
   * MacroEvent with forecast/previous data where available.
   */
  async fetchMacroCalendar(
    daysAhead: number = 30,
  ): Promise<MacroEvent[]> {
    const today = this.today();
    const futureDate = this.daysFromNow(daysAhead);

    // Fetch upcoming release dates
    const releaseDatesRes = await this.fetchWithResilience<FREDReleaseDatesResponse>(
      '/releases/dates',
      undefined,
      this.withAuth({
        realtime_start: today,
        realtime_end: futureDate,
        include_release_dates_with_no_data: 'true',
        sort_order: 'asc',
        limit: '1000',
      }),
    );

    const releaseDates = releaseDatesRes.data.release_dates;
    if (!releaseDates || releaseDates.length === 0) {
      this.logger.info('No upcoming FRED releases found', { today, futureDate });
      return [];
    }

    // Fetch release details for categorisation
    const releasesRes = await this.fetchWithResilience<FREDReleasesResponse>(
      '/releases',
      undefined,
      this.withAuth({
        realtime_start: today,
        realtime_end: futureDate,
        limit: '1000',
      }),
    );

    // Build a map of release_id -> release info
    const releaseMap = new Map<number, FREDRelease>();
    for (const release of releasesRes.data.releases || []) {
      releaseMap.set(release.id, release);
    }

    // Convert release dates to MacroEvents
    const events: MacroEvent[] = [];

    for (const rd of releaseDates) {
      const release = releaseMap.get(rd.release_id);
      const category = this.categorizeRelease(rd.release_name);
      const impact = this.assessImpact(rd.release_name);

      events.push({
        id: `fred-release-${rd.release_id}-${rd.date}`,
        name: rd.release_name,
        country: 'US', // FRED is US-focused
        category,
        scheduledAt: new Date(rd.date + 'T00:00:00Z').toISOString(),
        actual: null, // Not yet released
        forecast: null,
        previous: null,
        unit: '',
        impact,
        source: 'fred',
      });
    }

    this.logger.info('Fetched FRED macro calendar', {
      eventCount: events.length,
      from: today,
      to: futureDate,
    });

    return events;
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * Fetch metadata for a FRED series we don't have in our static map.
   *
   * Endpoint: GET /series?series_id={id}
   */
  private async fetchSeriesMeta(seriesId: string): Promise<SeriesMeta> {
    try {
      const response = await this.fetchWithResilience<FREDSeriesResponse>(
        '/series',
        undefined,
        this.withAuth({ series_id: seriesId }),
      );

      const series = response.data.seriess?.[0];
      if (!series) {
        this.logger.warn('FRED series metadata not found', { seriesId });
        return this.defaultMeta(seriesId);
      }

      return {
        category: this.categorizeRelease(series.title),
        name: series.title,
        unit: series.units_short || series.units || '',
        impact: 'medium',
        country: 'US',
      };
    } catch (err) {
      this.logger.warn('Failed to fetch FRED series metadata, using defaults', {
        seriesId,
        error: (err as Error).message,
      });
      return this.defaultMeta(seriesId);
    }
  }

  private defaultMeta(seriesId: string): SeriesMeta {
    return {
      category: MacroCategory.GDP,
      name: seriesId,
      unit: '',
      impact: 'medium',
      country: 'US',
    };
  }

  /**
   * Heuristic categorisation of FRED releases by name keywords.
   */
  private categorizeRelease(name: string): MacroCategory {
    const lower = name.toLowerCase();
    if (lower.includes('employ') || lower.includes('payroll') || lower.includes('jobless') || lower.includes('labor'))
      return MacroCategory.EMPLOYMENT;
    if (lower.includes('inflation') || lower.includes('price index') || lower.includes('cpi') || lower.includes('pce'))
      return MacroCategory.INFLATION;
    if (lower.includes('gdp') || lower.includes('gross domestic'))
      return MacroCategory.GDP;
    if (lower.includes('federal reserve') || lower.includes('treasury') || lower.includes('funds rate') || lower.includes('fomc'))
      return MacroCategory.CENTRAL_BANK;
    if (lower.includes('hous') || lower.includes('mortgage') || lower.includes('home'))
      return MacroCategory.HOUSING;
    if (lower.includes('manufactur') || lower.includes('industrial') || lower.includes('durable'))
      return MacroCategory.MANUFACTURING;
    if (lower.includes('consumer') || lower.includes('retail') || lower.includes('sentiment') || lower.includes('spending'))
      return MacroCategory.CONSUMER;
    if (lower.includes('trade') || lower.includes('export') || lower.includes('import') || lower.includes('balance'))
      return MacroCategory.TRADE;
    return MacroCategory.GDP; // Default
  }

  /**
   * Rough impact assessment based on release name.
   */
  private assessImpact(name: string): 'high' | 'medium' | 'low' {
    const lower = name.toLowerCase();
    const highImpact = [
      'employment situation', 'consumer price index', 'gdp', 'fomc',
      'federal funds', 'non-farm', 'payroll', 'retail sales',
      'pce price', 'unemployment',
    ];
    for (const term of highImpact) {
      if (lower.includes(term)) return 'high';
    }
    const mediumImpact = [
      'housing', 'durable', 'industrial', 'treasury', 'trade',
      'consumer sentiment', 'manufacturing', 'jobless claims',
    ];
    for (const term of mediumImpact) {
      if (lower.includes(term)) return 'medium';
    }
    return 'low';
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private yearsAgo(n: number): string {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    return d.toISOString().slice(0, 10);
  }

  private daysFromNow(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.fetchWithResilience<FREDSeriesResponse>(
        '/series',
        undefined,
        this.withAuth({ series_id: 'DGS10' }),
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
