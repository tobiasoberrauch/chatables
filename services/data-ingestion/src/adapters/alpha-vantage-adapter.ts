/**
 * Alpha Vantage Data Adapter
 *
 * Provides access to Alpha Vantage API for:
 *  - Foreign exchange (FX) rates
 *  - Daily adjusted stock prices
 *  - Macroeconomic indicators (GDP, CPI, unemployment, etc.)
 *
 * API Reference: https://www.alphavantage.co/documentation/
 * REST base:     https://www.alphavantage.co
 *
 * Authentication is via an `apikey` query parameter.
 * Free tier: 5 requests/minute, 500 requests/day.
 */

import { BaseAdapter, AdapterConfig, AdapterError } from './base-adapter';
import {
  OHLCVBar,
  BarSize,
  MacroEvent,
  MacroCategory,
} from '../../../../shared/src/types/instrument';

// ----------------------------------------------------------------
// Alpha Vantage raw response shapes
// ----------------------------------------------------------------

interface AVMetaData {
  '1. Information': string;
  '2. Symbol'?: string;
  '3. Last Refreshed': string;
  '4. Output Size'?: string;
  '5. Time Zone': string;
  '2. From Symbol'?: string;
  '3. To Symbol'?: string;
}

interface AVDailyRecord {
  '1. open': string;
  '2. high': string;
  '3. low': string;
  '4. close': string;
  '5. adjusted close': string;
  '6. volume': string;
  '7. dividend amount': string;
  '8. split coefficient': string;
}

interface AVDailyAdjustedResponse {
  'Meta Data': AVMetaData;
  'Time Series (Daily)': Record<string, AVDailyRecord>;
  Note?: string;         // Rate limit notice
  Information?: string;  // API key message
}

interface AVFxRateResponse {
  'Realtime Currency Exchange Rate': {
    '1. From_Currency Code': string;
    '2. From_Currency Name': string;
    '3. To_Currency Code': string;
    '4. To_Currency Name': string;
    '5. Exchange Rate': string;
    '6. Last Refreshed': string;
    '7. Time Zone': string;
    '8. Bid Price': string;
    '9. Ask Price': string;
  };
}

interface AVFxDailyRecord {
  '1. open': string;
  '2. high': string;
  '3. low': string;
  '4. close': string;
}

interface AVFxDailyResponse {
  'Meta Data': AVMetaData;
  'Time Series FX (Daily)': Record<string, AVFxDailyRecord>;
  Note?: string;
  Information?: string;
}

/** Alpha Vantage economic indicator data point */
interface AVEconomicDataPoint {
  date: string;
  value: string;
}

interface AVEconomicResponse {
  name: string;
  interval: string;
  unit: string;
  data: AVEconomicDataPoint[];
  Note?: string;
  Information?: string;
}

// ----------------------------------------------------------------
// Macroeconomic series mapping
// ----------------------------------------------------------------

/** Maps our canonical series names to Alpha Vantage function names */
const MACRO_SERIES_MAP: Record<string, { function: string; category: MacroCategory; name: string; unit: string; impact: 'high' | 'medium' | 'low' }> = {
  'REAL_GDP':               { function: 'REAL_GDP', category: MacroCategory.GDP, name: 'US Real GDP', unit: 'B$', impact: 'high' },
  'REAL_GDP_PER_CAPITA':    { function: 'REAL_GDP_PER_CAPITA', category: MacroCategory.GDP, name: 'US Real GDP Per Capita', unit: '$', impact: 'medium' },
  'TREASURY_YIELD':         { function: 'TREASURY_YIELD', category: MacroCategory.CENTRAL_BANK, name: 'US Treasury Yield', unit: '%', impact: 'high' },
  'FEDERAL_FUNDS_RATE':     { function: 'FEDERAL_FUNDS_RATE', category: MacroCategory.CENTRAL_BANK, name: 'Federal Funds Rate', unit: '%', impact: 'high' },
  'CPI':                    { function: 'CPI', category: MacroCategory.INFLATION, name: 'Consumer Price Index', unit: 'index', impact: 'high' },
  'INFLATION':              { function: 'INFLATION', category: MacroCategory.INFLATION, name: 'US Inflation Rate', unit: '%', impact: 'high' },
  'RETAIL_SALES':           { function: 'RETAIL_SALES', category: MacroCategory.CONSUMER, name: 'US Retail Sales', unit: 'M$', impact: 'medium' },
  'DURABLES':               { function: 'DURABLES', category: MacroCategory.MANUFACTURING, name: 'US Durable Goods Orders', unit: 'M$', impact: 'medium' },
  'UNEMPLOYMENT':           { function: 'UNEMPLOYMENT', category: MacroCategory.EMPLOYMENT, name: 'US Unemployment Rate', unit: '%', impact: 'high' },
  'NONFARM_PAYROLL':        { function: 'NONFARM_PAYROLL', category: MacroCategory.EMPLOYMENT, name: 'US Non-Farm Payrolls', unit: 'K', impact: 'high' },
};

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export class AlphaVantageAdapter extends BaseAdapter {
  private static readonly BASE_URL = 'https://www.alphavantage.co';

  constructor(config: AdapterConfig) {
    super({ ...config, providerName: config.providerName ?? 'alphaVantage' });
  }

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? AlphaVantageAdapter.BASE_URL;
  }

  /**
   * Alpha Vantage uses query param auth — no headers needed.
   */
  protected getAuthHeaders(): Record<string, string> {
    return {};
  }

  /** Inject the apikey into every request */
  private withApiKey(params: Record<string, string>): Record<string, string> {
    return { ...params, apikey: this.config.apiKey };
  }

  // -------------------------------------------------------------------
  // Validation hook
  // -------------------------------------------------------------------

  protected validate(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn('Alpha Vantage returned non-object response');
      return false;
    }

    const obj = raw as Record<string, unknown>;

    // Alpha Vantage returns a "Note" field when you hit the rate limit
    if (obj['Note'] && typeof obj['Note'] === 'string') {
      this.logger.warn('Alpha Vantage rate limit note received', {
        note: obj['Note'],
      });
      // We still return the data; caller can decide to retry
    }

    // "Information" field often means invalid API key or premium endpoint
    if (obj['Information'] && typeof obj['Information'] === 'string') {
      const info = obj['Information'] as string;
      if (info.includes('premium') || info.includes('API key')) {
        this.logger.warn('Alpha Vantage access issue', { information: info });
        return false;
      }
    }

    // "Error Message" means invalid function or symbol
    if (obj['Error Message']) {
      this.logger.warn('Alpha Vantage error', { error: obj['Error Message'] });
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------
  // fetchFxRate
  // -------------------------------------------------------------------

  /**
   * Fetch real-time exchange rate for a currency pair.
   *
   * Endpoint: GET /query?function=CURRENCY_EXCHANGE_RATE&from_currency={from}&to_currency={to}
   */
  async fetchFxRate(
    fromCurrency: string,
    toCurrency: string,
  ): Promise<{
    from: string;
    to: string;
    rate: number;
    bidPrice: number;
    askPrice: number;
    timestamp: string;
  }> {
    const response = await this.fetchWithResilience<AVFxRateResponse>(
      '/query',
      undefined,
      this.withApiKey({
        function: 'CURRENCY_EXCHANGE_RATE',
        from_currency: fromCurrency.toUpperCase(),
        to_currency: toCurrency.toUpperCase(),
      }),
    );

    const fx = response.data['Realtime Currency Exchange Rate'];
    if (!fx) {
      throw new AdapterError('alphaVantage', `No FX rate data for ${fromCurrency}/${toCurrency}`);
    }

    const rate = parseFloat(fx['5. Exchange Rate']);
    const bid = parseFloat(fx['8. Bid Price']);
    const ask = parseFloat(fx['9. Ask Price']);

    if (isNaN(rate) || rate <= 0) {
      this.logger.warn('Alpha Vantage returned invalid FX rate', {
        fromCurrency,
        toCurrency,
        rawRate: fx['5. Exchange Rate'],
      });
    }

    // Log abnormal bid-ask spread
    if (!isNaN(bid) && !isNaN(ask) && bid > 0) {
      const spreadPct = ((ask - bid) / bid) * 100;
      if (spreadPct > 1) {
        this.logger.warn('Wide FX spread detected', {
          pair: `${fromCurrency}/${toCurrency}`,
          bid,
          ask,
          spreadPct: spreadPct.toFixed(4),
        });
      }
    }

    return {
      from: fromCurrency.toUpperCase(),
      to: toCurrency.toUpperCase(),
      rate,
      bidPrice: isNaN(bid) ? rate : bid,
      askPrice: isNaN(ask) ? rate : ask,
      timestamp: new Date(fx['6. Last Refreshed'] + ' UTC').toISOString(),
    };
  }

  // -------------------------------------------------------------------
  // fetchFxDaily
  // -------------------------------------------------------------------

  /**
   * Fetch daily FX OHLC bars.
   *
   * Endpoint: GET /query?function=FX_DAILY&from_symbol={from}&to_symbol={to}&outputsize=full
   */
  async fetchFxDaily(
    fromCurrency: string,
    toCurrency: string,
    instrumentId: string = '',
    outputSize: 'compact' | 'full' = 'compact',
  ): Promise<OHLCVBar[]> {
    const response = await this.fetchWithResilience<AVFxDailyResponse>(
      '/query',
      undefined,
      this.withApiKey({
        function: 'FX_DAILY',
        from_symbol: fromCurrency.toUpperCase(),
        to_symbol: toCurrency.toUpperCase(),
        outputsize: outputSize,
      }),
    );

    const timeSeries = response.data['Time Series FX (Daily)'];
    if (!timeSeries) {
      this.logger.warn('Alpha Vantage returned no FX daily data', {
        fromCurrency,
        toCurrency,
      });
      return [];
    }

    const bars: OHLCVBar[] = [];
    const sortedDates = Object.keys(timeSeries).sort();

    for (const dateStr of sortedDates) {
      const raw = timeSeries[dateStr];
      const open = parseFloat(raw['1. open']);
      const high = parseFloat(raw['2. high']);
      const low = parseFloat(raw['3. low']);
      const close = parseFloat(raw['4. close']);

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
        this.logger.warn('Alpha Vantage FX bar has NaN values, skipping', {
          date: dateStr,
          pair: `${fromCurrency}/${toCurrency}`,
        });
        continue;
      }

      if (high < low) {
        this.logger.warn('Alpha Vantage FX bar has high < low', {
          date: dateStr,
          high,
          low,
        });
      }

      bars.push({
        instrumentId,
        timestamp: new Date(dateStr + 'T00:00:00Z').toISOString(),
        open,
        high,
        low,
        close,
        volume: 0, // FX doesn't have volume in Alpha Vantage
        vwap: null,
        trades: null,
        barSize: BarSize.DAY_1,
        isAdjusted: false,
        source: 'alphaVantage',
      });
    }

    this.logger.info('Fetched Alpha Vantage FX daily bars', {
      pair: `${fromCurrency}/${toCurrency}`,
      barCount: bars.length,
    });

    return bars;
  }

  // -------------------------------------------------------------------
  // fetchDailyAdjusted
  // -------------------------------------------------------------------

  /**
   * Fetch daily adjusted OHLCV bars for an equity ticker.
   *
   * Endpoint: GET /query?function=TIME_SERIES_DAILY_ADJUSTED&symbol={ticker}&outputsize=full
   *
   * This returns split- and dividend-adjusted close prices alongside raw OHLCV.
   */
  async fetchDailyAdjusted(
    ticker: string,
    instrumentId: string = '',
    outputSize: 'compact' | 'full' = 'compact',
  ): Promise<OHLCVBar[]> {
    const response = await this.fetchWithResilience<AVDailyAdjustedResponse>(
      '/query',
      undefined,
      this.withApiKey({
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        symbol: ticker.toUpperCase(),
        outputsize: outputSize,
      }),
    );

    const timeSeries = response.data['Time Series (Daily)'];
    if (!timeSeries) {
      this.logger.warn('Alpha Vantage returned no daily adjusted data', { ticker });
      return [];
    }

    const bars: OHLCVBar[] = [];
    const sortedDates = Object.keys(timeSeries).sort();

    let previousClose: number | null = null;

    for (const dateStr of sortedDates) {
      const raw = timeSeries[dateStr];
      const open = parseFloat(raw['1. open']);
      const high = parseFloat(raw['2. high']);
      const low = parseFloat(raw['3. low']);
      const close = parseFloat(raw['4. close']);
      const adjustedClose = parseFloat(raw['5. adjusted close']);
      const volume = parseInt(raw['6. volume'], 10);
      const splitCoeff = parseFloat(raw['8. split coefficient']);

      if (isNaN(open) || isNaN(close)) {
        this.logger.warn('Alpha Vantage bar has NaN OHLC, skipping', {
          ticker,
          date: dateStr,
        });
        continue;
      }

      // Detect large gap from previous close (potential data issue or stock event)
      if (previousClose !== null && previousClose > 0) {
        const gapPct = Math.abs((open - previousClose) / previousClose) * 100;
        if (gapPct > 50 && splitCoeff === 1) {
          this.logger.warn('Large overnight gap detected (possible data anomaly)', {
            ticker,
            date: dateStr,
            previousClose,
            open,
            gapPct: gapPct.toFixed(2),
          });
        }
      }

      // Apply adjustment ratio: adjustedClose / rawClose
      const adjRatio = adjustedClose / close;
      const adjOpen = open * adjRatio;
      const adjHigh = high * adjRatio;
      const adjLow = low * adjRatio;

      bars.push({
        instrumentId,
        timestamp: new Date(dateStr + 'T00:00:00Z').toISOString(),
        open: adjOpen,
        high: adjHigh,
        low: adjLow,
        close: adjustedClose,
        volume: isNaN(volume) ? 0 : volume,
        vwap: null,
        trades: null,
        barSize: BarSize.DAY_1,
        isAdjusted: true,
        source: 'alphaVantage',
      });

      previousClose = close;
    }

    this.logger.info('Fetched Alpha Vantage daily adjusted bars', {
      ticker,
      barCount: bars.length,
    });

    return bars;
  }

  // -------------------------------------------------------------------
  // fetchMacroindicator
  // -------------------------------------------------------------------

  /**
   * Fetch a macroeconomic indicator series from Alpha Vantage.
   *
   * Endpoint: GET /query?function={SERIES_NAME}&interval=monthly
   *
   * Supported series: REAL_GDP, CPI, INFLATION, UNEMPLOYMENT,
   *   NONFARM_PAYROLL, FEDERAL_FUNDS_RATE, TREASURY_YIELD, RETAIL_SALES,
   *   DURABLES, REAL_GDP_PER_CAPITA
   */
  async fetchMacroindicator(
    seriesName: string,
    interval: 'monthly' | 'quarterly' | 'annual' = 'monthly',
  ): Promise<MacroEvent[]> {
    const seriesConfig = MACRO_SERIES_MAP[seriesName.toUpperCase()];
    if (!seriesConfig) {
      throw new AdapterError(
        'alphaVantage',
        `Unknown macro series: ${seriesName}. Supported: ${Object.keys(MACRO_SERIES_MAP).join(', ')}`,
      );
    }

    const queryParams: Record<string, string> = {
      function: seriesConfig.function,
    };

    // Some series accept an interval parameter
    if (['TREASURY_YIELD', 'FEDERAL_FUNDS_RATE', 'CPI'].includes(seriesConfig.function)) {
      queryParams.interval = interval;
    }

    const response = await this.fetchWithResilience<AVEconomicResponse>(
      '/query',
      undefined,
      this.withApiKey(queryParams),
    );

    const body = response.data;

    if (!body.data || body.data.length === 0) {
      this.logger.warn('Alpha Vantage returned no macro data', { seriesName });
      return [];
    }

    const events: MacroEvent[] = [];
    let previousValue: number | null = null;

    for (let i = 0; i < body.data.length; i++) {
      const point = body.data[i];
      const value = point.value === '.' ? null : parseFloat(point.value);

      if (value !== null && isNaN(value)) {
        this.logger.warn('Alpha Vantage macro data point is NaN, skipping', {
          seriesName,
          date: point.date,
          rawValue: point.value,
        });
        continue;
      }

      // The previous data point in the array is the "previous" reading
      // (Alpha Vantage returns data in reverse chronological order)
      const prevValue = i + 1 < body.data.length
        ? parseFloat(body.data[i + 1].value)
        : previousValue;

      events.push({
        id: `av-${seriesConfig.function}-${point.date}`,
        name: seriesConfig.name,
        country: 'US',
        category: seriesConfig.category,
        scheduledAt: new Date(point.date + 'T00:00:00Z').toISOString(),
        actual: value,
        forecast: null, // Alpha Vantage doesn't provide forecasts
        previous: prevValue != null && !isNaN(prevValue) ? prevValue : null,
        unit: seriesConfig.unit,
        impact: seriesConfig.impact,
        source: 'alphaVantage',
      });

      if (value !== null) {
        previousValue = value;
      }
    }

    this.logger.info('Fetched Alpha Vantage macro indicator', {
      seriesName,
      dataPoints: events.length,
    });

    return events;
  }

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      // Use a lightweight call: FX rate for EUR/USD
      await this.fetchWithResilience<AVFxRateResponse>(
        '/query',
        undefined,
        this.withApiKey({
          function: 'CURRENCY_EXCHANGE_RATE',
          from_currency: 'EUR',
          to_currency: 'USD',
        }),
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
