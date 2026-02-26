/**
 * News Sentiment Tagging Pipeline
 *
 * Provides both LLM-based and rule-based sentiment analysis for news articles.
 *
 * Architecture:
 *   1. Primary path: LLM-based analysis via a configurable provider interface.
 *   2. Fallback path: deterministic rule-based scoring using curated keyword lists
 *      and heuristic weighting. Used when the LLM is unavailable or for
 *      low-latency requirements.
 *   3. Batch processing: groups articles for efficient LLM API calls.
 *
 * Sentiment output:
 *   score  ∈ [-1, 1]  — continuous confidence-weighted sentiment
 *   label  ∈ { 'bearish' | 'neutral' | 'bullish' }
 */

import type { NewsArticle } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SentimentLabel = 'bearish' | 'neutral' | 'bullish';

export interface SentimentResult {
  articleId: string;
  score: number;          // -1.0 (most bearish) to 1.0 (most bullish)
  label: SentimentLabel;
  confidence: number;     // 0.0 to 1.0
  method: 'llm' | 'rule-based';
}

export interface BatchSentimentResult {
  results: SentimentResult[];
  processingTimeMs: number;
  method: 'llm' | 'rule-based';
}

// ---------------------------------------------------------------------------
// LLM Provider Interface
// ---------------------------------------------------------------------------

/**
 * Interface that any LLM backend must implement to be used for sentiment
 * analysis. This decouples the pipeline from any specific model provider
 * (OpenAI, Anthropic, local models, etc.).
 */
export interface LLMSentimentProvider {
  /**
   * Analyse a single article and return a sentiment score.
   * The provider should return a score in [-1, 1] and a confidence in [0, 1].
   */
  analyze(text: string): Promise<{ score: number; confidence: number }>;

  /**
   * Analyse a batch of articles. Providers that support batch APIs can
   * override this for efficiency. Default implementation calls analyze()
   * for each item sequentially.
   */
  analyzeBatch?(texts: string[]): Promise<Array<{ score: number; confidence: number }>>;

  /** Whether the provider is currently available / healthy. */
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Rule-based fallback — Keyword dictionaries
// ---------------------------------------------------------------------------

interface WeightedTerm {
  term: string;
  weight: number; // positive for bullish, negative for bearish
}

/**
 * Curated keyword lists for financial sentiment. Weights reflect typical
 * market impact intensity. These are intentionally conservative to avoid
 * false positives.
 */
const SENTIMENT_TERMS: WeightedTerm[] = [
  // Strong bullish signals
  { term: 'beat expectations', weight: 0.8 },
  { term: 'record revenue', weight: 0.8 },
  { term: 'record profit', weight: 0.8 },
  { term: 'all-time high', weight: 0.7 },
  { term: 'strong growth', weight: 0.7 },
  { term: 'raised guidance', weight: 0.8 },
  { term: 'raises guidance', weight: 0.8 },
  { term: 'upgraded', weight: 0.6 },
  { term: 'upgrade', weight: 0.6 },
  { term: 'outperform', weight: 0.6 },
  { term: 'surpassed', weight: 0.6 },
  { term: 'exceeded', weight: 0.6 },
  { term: 'exceeds', weight: 0.6 },
  { term: 'bullish', weight: 0.5 },
  { term: 'rally', weight: 0.5 },
  { term: 'rallied', weight: 0.5 },
  { term: 'surge', weight: 0.5 },
  { term: 'surged', weight: 0.5 },
  { term: 'soared', weight: 0.5 },
  { term: 'breakout', weight: 0.5 },
  { term: 'positive momentum', weight: 0.5 },
  { term: 'strong demand', weight: 0.5 },
  { term: 'beat estimates', weight: 0.7 },
  { term: 'accelerating growth', weight: 0.7 },
  { term: 'margin expansion', weight: 0.6 },
  { term: 'buyback', weight: 0.4 },
  { term: 'share repurchase', weight: 0.4 },
  { term: 'dividend increase', weight: 0.5 },
  { term: 'dividend hike', weight: 0.5 },
  { term: 'optimistic', weight: 0.4 },
  { term: 'upside', weight: 0.4 },

  // Moderate bullish
  { term: 'growth', weight: 0.2 },
  { term: 'profit', weight: 0.15 },
  { term: 'gains', weight: 0.2 },
  { term: 'positive', weight: 0.15 },
  { term: 'improved', weight: 0.2 },
  { term: 'recovery', weight: 0.3 },
  { term: 'rebound', weight: 0.3 },

  // Moderate bearish
  { term: 'decline', weight: -0.2 },
  { term: 'declined', weight: -0.2 },
  { term: 'loss', weight: -0.2 },
  { term: 'losses', weight: -0.25 },
  { term: 'weakness', weight: -0.2 },
  { term: 'weak', weight: -0.15 },
  { term: 'uncertainty', weight: -0.15 },
  { term: 'risk', weight: -0.1 },
  { term: 'volatile', weight: -0.1 },
  { term: 'volatility', weight: -0.1 },
  { term: 'concern', weight: -0.15 },
  { term: 'concerns', weight: -0.15 },
  { term: 'pressure', weight: -0.15 },
  { term: 'slowdown', weight: -0.3 },
  { term: 'slowing', weight: -0.2 },

  // Strong bearish signals
  { term: 'missed expectations', weight: -0.8 },
  { term: 'miss estimates', weight: -0.7 },
  { term: 'missed estimates', weight: -0.7 },
  { term: 'lowered guidance', weight: -0.8 },
  { term: 'lowers guidance', weight: -0.8 },
  { term: 'cut guidance', weight: -0.8 },
  { term: 'downgraded', weight: -0.6 },
  { term: 'downgrade', weight: -0.6 },
  { term: 'underperform', weight: -0.6 },
  { term: 'bearish', weight: -0.5 },
  { term: 'selloff', weight: -0.6 },
  { term: 'sell-off', weight: -0.6 },
  { term: 'crash', weight: -0.8 },
  { term: 'plunged', weight: -0.7 },
  { term: 'plummeted', weight: -0.7 },
  { term: 'collapsed', weight: -0.8 },
  { term: 'bankruptcy', weight: -0.9 },
  { term: 'fraud', weight: -0.9 },
  { term: 'investigation', weight: -0.5 },
  { term: 'lawsuit', weight: -0.4 },
  { term: 'recall', weight: -0.5 },
  { term: 'layoffs', weight: -0.4 },
  { term: 'restructuring', weight: -0.3 },
  { term: 'margin compression', weight: -0.6 },
  { term: 'dividend cut', weight: -0.6 },
  { term: 'debt downgrade', weight: -0.7 },
  { term: 'default', weight: -0.8 },
  { term: 'recession', weight: -0.6 },
  { term: 'downside', weight: -0.4 },
  { term: 'pessimistic', weight: -0.4 },
  { term: 'warning', weight: -0.4 },
  { term: 'warned', weight: -0.4 },
];

// Pre-sort by term length descending so longer (more specific) phrases match first.
const SORTED_TERMS = [...SENTIMENT_TERMS].sort(
  (a, b) => b.term.length - a.term.length,
);

// ---------------------------------------------------------------------------
// Rule-based scoring engine
// ---------------------------------------------------------------------------

/**
 * Analyse the sentiment of a text using the rule-based keyword approach.
 *
 * Algorithm:
 *   1. Normalise text to lowercase.
 *   2. Scan for each term in the dictionary. Count occurrences.
 *   3. Compute a raw score as the sum of (weight * count) for all matched terms.
 *   4. Normalise the raw score to [-1, 1] using a sigmoid-like compression:
 *        score = tanh(rawScore)
 *   5. Derive confidence from the number of matched terms and total matches.
 */
export function ruleBasedSentiment(text: string): { score: number; confidence: number } {
  const lower = text.toLowerCase();
  let rawScore = 0;
  let matchCount = 0;
  let termHits = 0;

  for (const { term, weight } of SORTED_TERMS) {
    // Count all non-overlapping occurrences
    let idx = 0;
    let count = 0;
    while (true) {
      const found = lower.indexOf(term, idx);
      if (found === -1) break;
      count++;
      idx = found + term.length;
    }
    if (count > 0) {
      rawScore += weight * count;
      matchCount += count;
      termHits++;
    }
  }

  // Compress raw score to [-1, 1] using hyperbolic tangent
  const score = Math.tanh(rawScore);

  // Confidence is based on how many distinct terms matched and total hit count.
  // More matches => higher confidence, capped at 1.
  // With 0 matches confidence is minimal (we still return neutral).
  const confidence = matchCount === 0
    ? 0.1 // Very low confidence when no keywords found
    : Math.min(1, 0.3 + 0.1 * termHits + 0.02 * matchCount);

  return { score, confidence };
}

/**
 * Convert a continuous score to a discrete label.
 * Thresholds: score <= -0.15 => bearish, score >= 0.15 => bullish, else neutral.
 */
export function scoreToLabel(score: number): SentimentLabel {
  if (score <= -0.15) return 'bearish';
  if (score >= 0.15) return 'bullish';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Sentiment Pipeline
// ---------------------------------------------------------------------------

export interface SentimentPipelineOptions {
  /** LLM provider for primary analysis path. Optional — falls back to rules. */
  llmProvider?: LLMSentimentProvider;
  /** Maximum number of articles to include in a single LLM batch call. Default 10. */
  batchSize?: number;
  /** Timeout per LLM call in milliseconds. Default 30000. */
  llmTimeoutMs?: number;
}

/**
 * The main sentiment analysis pipeline.
 *
 * Usage:
 * ```ts
 * const pipeline = new NewsSentimentPipeline({ llmProvider: myProvider });
 * const results = await pipeline.analyzeArticles(articles);
 * ```
 */
export class NewsSentimentPipeline {
  private readonly llmProvider?: LLMSentimentProvider;
  private readonly batchSize: number;
  private readonly llmTimeoutMs: number;

  constructor(options: SentimentPipelineOptions = {}) {
    this.llmProvider = options.llmProvider;
    this.batchSize = options.batchSize ?? 10;
    this.llmTimeoutMs = options.llmTimeoutMs ?? 30_000;
  }

  /**
   * Analyse a single article. Attempts LLM first, falls back to rule-based.
   */
  async analyzeArticle(article: NewsArticle): Promise<SentimentResult> {
    const text = this.extractText(article);

    // Attempt LLM path
    if (this.llmProvider) {
      try {
        const available = await this.llmProvider.isAvailable();
        if (available) {
          const llmResult = await this.withTimeout(
            this.llmProvider.analyze(text),
            this.llmTimeoutMs,
          );
          const score = clamp(llmResult.score, -1, 1);
          return {
            articleId: article.id,
            score,
            label: scoreToLabel(score),
            confidence: clamp(llmResult.confidence, 0, 1),
            method: 'llm',
          };
        }
      } catch {
        // Fall through to rule-based
      }
    }

    // Rule-based fallback
    const { score, confidence } = ruleBasedSentiment(text);
    return {
      articleId: article.id,
      score,
      label: scoreToLabel(score),
      confidence,
      method: 'rule-based',
    };
  }

  /**
   * Analyse a batch of articles efficiently.
   *
   * If the LLM provider supports batch analysis, articles are grouped into
   * chunks of `batchSize` and sent together. Otherwise, each article is
   * analysed individually. On any LLM failure for a chunk, those articles
   * fall back to rule-based analysis.
   */
  async analyzeArticles(articles: NewsArticle[]): Promise<BatchSentimentResult> {
    if (articles.length === 0) {
      return { results: [], processingTimeMs: 0, method: 'rule-based' };
    }

    const startTime = Date.now();
    let usedLLM = false;

    // Check LLM availability once
    let llmAvailable = false;
    if (this.llmProvider) {
      try {
        llmAvailable = await this.llmProvider.isAvailable();
      } catch {
        llmAvailable = false;
      }
    }

    const results: SentimentResult[] = [];

    if (llmAvailable && this.llmProvider) {
      // Process in batches
      const chunks = chunkArray(articles, this.batchSize);
      const provider = this.llmProvider;

      for (const chunk of chunks) {
        const texts = chunk.map((a) => this.extractText(a));

        try {
          let llmResults: Array<{ score: number; confidence: number }>;

          if (provider.analyzeBatch) {
            llmResults = await this.withTimeout(
              provider.analyzeBatch(texts),
              this.llmTimeoutMs * Math.ceil(texts.length / 5),
            );
          } else {
            // Sequential fallback when batch not supported
            llmResults = await this.withTimeout(
              Promise.all(texts.map((t) => provider.analyze(t))),
              this.llmTimeoutMs * texts.length,
            );
          }

          for (let i = 0; i < chunk.length; i++) {
            const score = clamp(llmResults[i].score, -1, 1);
            results.push({
              articleId: chunk[i].id,
              score,
              label: scoreToLabel(score),
              confidence: clamp(llmResults[i].confidence, 0, 1),
              method: 'llm',
            });
          }
          usedLLM = true;
        } catch {
          // Fallback entire chunk to rule-based
          for (const article of chunk) {
            const text = this.extractText(article);
            const { score, confidence } = ruleBasedSentiment(text);
            results.push({
              articleId: article.id,
              score,
              label: scoreToLabel(score),
              confidence,
              method: 'rule-based',
            });
          }
        }
      }
    } else {
      // Pure rule-based path
      for (const article of articles) {
        const text = this.extractText(article);
        const { score, confidence } = ruleBasedSentiment(text);
        results.push({
          articleId: article.id,
          score,
          label: scoreToLabel(score),
          confidence,
          method: 'rule-based',
        });
      }
    }

    return {
      results,
      processingTimeMs: Date.now() - startTime,
      method: usedLLM ? 'llm' : 'rule-based',
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Extract the best available text from an article.
   * Prefers full content, falls back to summary + title.
   */
  private extractText(article: NewsArticle): string {
    if (article.content) {
      return `${article.title}\n${article.content}`;
    }
    return `${article.title}\n${article.summary}`;
  }

  /** Promise.race with a timeout. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms);
      promise
        .then((val) => {
          clearTimeout(timer);
          resolve(val);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
