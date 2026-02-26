/**
 * NewsAPI.org Data Adapter
 *
 * Provides access to NewsAPI.org for:
 *  - Top headlines by category/country
 *  - Full-text article search with date ranges
 *
 * API Reference: https://newsapi.org/docs
 * REST base:     https://newsapi.org/v2
 *
 * Authentication is via an `X-Api-Key` header or `apiKey` query param.
 * Free tier: 100 requests/day, developer plan; articles delayed 24h.
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseAdapter, AdapterConfig, AdapterError } from './base-adapter';
import { NewsArticle } from '../../../../shared/src/types/instrument';

// ----------------------------------------------------------------
// NewsAPI raw response shapes
// ----------------------------------------------------------------

interface NewsAPISource {
  id: string | null;
  name: string;
}

interface NewsAPIArticle {
  source: NewsAPISource;
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null; // Truncated to 200 chars on free tier
}

interface NewsAPIResponse {
  status: string;          // "ok" or "error"
  totalResults: number;
  articles: NewsAPIArticle[];
  code?: string;           // Error code
  message?: string;        // Error message
}

// ----------------------------------------------------------------
// Category mappings
// ----------------------------------------------------------------

/** NewsAPI top-headlines categories */
type NewsAPICategory =
  | 'business'
  | 'entertainment'
  | 'general'
  | 'health'
  | 'science'
  | 'sports'
  | 'technology';

/**
 * Known financial news source IDs on NewsAPI that are high-quality
 * for market-related content. Used for relevance scoring.
 */
const FINANCIAL_SOURCES = new Set([
  'bloomberg',
  'business-insider',
  'financial-times',
  'fortune',
  'the-wall-street-journal',
  'reuters',
  'cnbc',
  'the-economist',
  'associated-press',
  'bbc-news',
]);

// ----------------------------------------------------------------
// Ticker extraction
// ----------------------------------------------------------------

/**
 * Very simple regex-based ticker extraction from article text.
 * Production systems would use NLP/NER, but this covers the common
 * "$AAPL" and "(AAPL)" patterns seen in financial journalism.
 */
function extractTickers(text: string): string[] {
  if (!text) return [];

  const tickers = new Set<string>();

  // Match "$AAPL" style
  const cashtagRegex = /\$([A-Z]{1,5})\b/g;
  let match;
  while ((match = cashtagRegex.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  // Match "(NASDAQ: AAPL)" or "(NYSE: MSFT)" style
  const exchangeRegex = /\((?:NASDAQ|NYSE|AMEX|CBOE):\s*([A-Z]{1,5})\)/g;
  while ((match = exchangeRegex.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  return Array.from(tickers);
}

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export class NewsAdapter extends BaseAdapter {
  private static readonly BASE_URL = 'https://newsapi.org/v2';

  constructor(config: AdapterConfig) {
    super({ ...config, providerName: config.providerName ?? 'newsapi' });
  }

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? NewsAdapter.BASE_URL;
  }

  /**
   * NewsAPI uses X-Api-Key header for authentication.
   */
  protected getAuthHeaders(): Record<string, string> {
    return { 'X-Api-Key': this.config.apiKey };
  }

  // -------------------------------------------------------------------
  // Validation hook
  // -------------------------------------------------------------------

  protected validate(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn('NewsAPI returned non-object response');
      return false;
    }

    const obj = raw as NewsAPIResponse;

    if (obj.status === 'error') {
      this.logger.warn('NewsAPI returned error', {
        code: obj.code,
        message: obj.message,
      });
      return false;
    }

    if (obj.status !== 'ok') {
      this.logger.warn('NewsAPI returned unexpected status', { status: obj.status });
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------
  // fetchTopHeadlines
  // -------------------------------------------------------------------

  /**
   * Fetch top headlines, optionally filtered by category and/or country.
   *
   * Endpoint: GET /top-headlines?category={cat}&country={country}&pageSize={n}
   *
   * @param category   NewsAPI category (default: 'business')
   * @param country    ISO 3166-1 alpha-2 code (default: 'us')
   * @param pageSize   Number of results (max 100, default 50)
   */
  async fetchTopHeadlines(
    category: NewsAPICategory = 'business',
    country: string = 'us',
    pageSize: number = 50,
  ): Promise<NewsArticle[]> {
    const response = await this.fetchWithResilience<NewsAPIResponse>(
      '/top-headlines',
      undefined,
      {
        category,
        country: country.toLowerCase(),
        pageSize: String(Math.min(pageSize, 100)),
      },
    );

    const articles = response.data.articles;
    if (!articles || articles.length === 0) {
      this.logger.info('No top headlines returned', { category, country });
      return [];
    }

    const normalized = articles
      .map((a) => this.normalizeArticle(a, [category]))
      .filter((a): a is NewsArticle => a !== null);

    this.logger.info('Fetched top headlines', {
      category,
      country,
      rawCount: articles.length,
      normalizedCount: normalized.length,
    });

    return normalized;
  }

  // -------------------------------------------------------------------
  // searchNews
  // -------------------------------------------------------------------

  /**
   * Search for news articles matching a query within a date range.
   *
   * Endpoint: GET /everything?q={query}&from={from}&to={to}&sortBy=publishedAt&pageSize={n}&page={p}
   *
   * Automatically paginates up to `maxPages` pages.
   *
   * @param query     Search query (supports AND/OR/NOT and quoting)
   * @param from      Start date, YYYY-MM-DD (default: 7 days ago)
   * @param to        End date, YYYY-MM-DD (default: today)
   * @param maxPages  Max pages to fetch (default: 3)
   * @param pageSize  Results per page (max 100, default: 100)
   */
  async searchNews(
    query: string,
    from?: string,
    to?: string,
    maxPages: number = 3,
    pageSize: number = 100,
  ): Promise<NewsArticle[]> {
    const effectiveFrom = from ?? this.daysAgo(7);
    const effectiveTo = to ?? this.today();
    const effectivePageSize = Math.min(pageSize, 100);

    const allArticles: NewsArticle[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const response = await this.fetchWithResilience<NewsAPIResponse>(
        '/everything',
        undefined,
        {
          q: query,
          from: effectiveFrom,
          to: effectiveTo,
          sortBy: 'publishedAt',
          language: 'en',
          pageSize: String(effectivePageSize),
          page: String(page),
        },
      );

      const articles = response.data.articles;
      if (!articles || articles.length === 0) break;

      for (const article of articles) {
        const normalized = this.normalizeArticle(article, []);
        if (normalized) {
          allArticles.push(normalized);
        }
      }

      // Stop if we've gotten all results
      const totalFetched = page * effectivePageSize;
      if (totalFetched >= response.data.totalResults) break;
    }

    this.logger.info('Searched news articles', {
      query,
      from: effectiveFrom,
      to: effectiveTo,
      resultCount: allArticles.length,
    });

    return allArticles;
  }

  // -------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------

  private normalizeArticle(
    raw: NewsAPIArticle,
    categories: string[],
  ): NewsArticle | null {
    // Skip articles with "[Removed]" titles (NewsAPI returns these for
    // articles that have been taken down)
    if (!raw.title || raw.title === '[Removed]') {
      this.logger.debug('Skipping removed article', { url: raw.url });
      return null;
    }

    // Validate publishedAt is a valid date
    const publishedAt = new Date(raw.publishedAt);
    if (isNaN(publishedAt.getTime())) {
      this.logger.warn('Article has invalid publishedAt, skipping', {
        title: raw.title.slice(0, 80),
        publishedAt: raw.publishedAt,
      });
      return null;
    }

    // Extract tickers from title + description
    const combinedText = `${raw.title} ${raw.description || ''} ${raw.content || ''}`;
    const tickers = extractTickers(combinedText);

    // Very basic sentiment heuristic based on keyword presence.
    // A real system would use a model, but this gives a rough signal.
    const sentimentResult = this.basicSentiment(combinedText);

    const now = new Date().toISOString();

    return {
      id: uuidv4(),
      title: raw.title,
      summary: raw.description || '',
      content: raw.content || null,
      url: raw.url,
      source: raw.source.name || 'unknown',
      publishedAt: publishedAt.toISOString(),
      instrumentIds: [], // Resolved later via ticker-to-instrument mapping
      tickers,
      sentimentScore: sentimentResult.score,
      sentimentLabel: sentimentResult.label,
      categories: [
        ...categories,
        ...(FINANCIAL_SOURCES.has(raw.source.id || '') ? ['financial'] : []),
      ],
      createdAt: now,
    };
  }

  /**
   * Extremely basic keyword-based sentiment. This is a placeholder for a
   * proper NLP model. In production, this would call an ML service or use
   * a local transformer.
   */
  private basicSentiment(text: string): {
    score: number | null;
    label: 'bearish' | 'neutral' | 'bullish' | null;
  } {
    if (!text) return { score: null, label: null };

    const lower = text.toLowerCase();

    const bullishWords = [
      'surge', 'soar', 'rally', 'gain', 'record high', 'beat expectations',
      'strong earnings', 'upgrade', 'bullish', 'outperform', 'growth',
      'breakout', 'optimism', 'recovery', 'positive', 'profit',
    ];
    const bearishWords = [
      'crash', 'plunge', 'tumble', 'drop', 'decline', 'miss expectations',
      'weak earnings', 'downgrade', 'bearish', 'underperform', 'recession',
      'layoff', 'bankruptcy', 'negative', 'loss', 'sell-off', 'selloff',
    ];

    let bullishCount = 0;
    let bearishCount = 0;

    for (const word of bullishWords) {
      if (lower.includes(word)) bullishCount++;
    }
    for (const word of bearishWords) {
      if (lower.includes(word)) bearishCount++;
    }

    const total = bullishCount + bearishCount;
    if (total === 0) return { score: null, label: null };

    // Score ranges from -1 (all bearish) to +1 (all bullish)
    const score = (bullishCount - bearishCount) / total;

    let label: 'bearish' | 'neutral' | 'bullish';
    if (score > 0.2) label = 'bullish';
    else if (score < -0.2) label = 'bearish';
    else label = 'neutral';

    return { score: parseFloat(score.toFixed(3)), label };
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.fetchWithResilience<NewsAPIResponse>(
        '/top-headlines',
        undefined,
        { country: 'us', pageSize: '1' },
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
