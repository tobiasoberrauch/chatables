/**
 * Earnings Summary Extraction
 *
 * Provides LLM-powered extraction of structured data from earnings call
 * transcripts and press releases. Designed to produce machine-readable
 * output for downstream analytics (dashboards, alerts, screening).
 *
 * Structured output includes:
 *   - Revenue and EPS beat/miss vs. consensus
 *   - Forward guidance changes (raised / maintained / lowered)
 *   - Key management quotes
 *   - Segment-level highlights
 *   - Risk factors mentioned
 */

import type { EarningsEvent, CompanyFundamentals } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BeatMissStatus = 'beat' | 'miss' | 'inline' | 'not_reported';

export type GuidanceDirection = 'raised' | 'maintained' | 'lowered' | 'withdrawn' | 'initiated' | 'not_mentioned';

export interface MetricComparison {
  /** Reported actual value. */
  actual: number | null;
  /** Consensus estimate. */
  estimate: number | null;
  /** Absolute surprise (actual - estimate). */
  surprise: number | null;
  /** Surprise as a percentage of estimate. */
  surprisePercent: number | null;
  /** Classification. */
  status: BeatMissStatus;
}

export interface GuidanceUpdate {
  metric: string;               // e.g. "Revenue", "EPS", "Operating Margin"
  direction: GuidanceDirection;
  previousRange: string | null; // e.g. "$90B - $93B"
  newRange: string | null;      // e.g. "$94B - $97B"
  commentary: string | null;    // Verbatim or paraphrased management quote
}

export interface KeyQuote {
  speaker: string;              // e.g. "CEO Tim Cook"
  quote: string;                // Verbatim or close paraphrase
  topic: string;                // Brief topic label
}

export interface SegmentHighlight {
  segment: string;              // e.g. "Cloud", "iPhone", "Advertising"
  revenueGrowthYoY: number | null;  // Percentage
  commentary: string | null;
}

export interface RiskFactor {
  category: string;             // e.g. "Macro", "Regulatory", "Competition"
  description: string;
}

export interface EarningsSummary {
  /** Instrument / company identifier. */
  instrumentId: string;
  /** Fiscal period string, e.g. "Q1 FY2025". */
  fiscalPeriod: string;
  /** When the report was processed. */
  processedAt: string;          // ISO 8601

  // Core metrics
  revenue: MetricComparison;
  eps: MetricComparison;

  // Guidance
  guidanceUpdates: GuidanceUpdate[];

  // Qualitative
  keyQuotes: KeyQuote[];
  segmentHighlights: SegmentHighlight[];
  riskFactors: RiskFactor[];

  // Meta
  overallTone: 'positive' | 'neutral' | 'negative';
  confidenceScore: number;      // 0-1, how confident the extraction is
  method: 'llm' | 'structured-data';
}

// ---------------------------------------------------------------------------
// LLM Provider Interface for Earnings Extraction
// ---------------------------------------------------------------------------

/**
 * Interface for LLM providers that can extract structured earnings data.
 * The prompt engineering and schema enforcement are the caller's responsibility;
 * this interface simply wraps the LLM call.
 */
export interface EarningsLLMProvider {
  /**
   * Given a transcript or press release text, extract a structured summary.
   * The provider is expected to return data conforming to the LLMExtractionResult
   * schema. Partial results are acceptable.
   */
  extractEarningsSummary(text: string, context: EarningsExtractionContext): Promise<LLMExtractionResult>;

  /** Health check. */
  isAvailable(): Promise<boolean>;
}

/** Context passed to the LLM to improve extraction accuracy. */
export interface EarningsExtractionContext {
  companyName: string;
  ticker: string;
  fiscalPeriod: string;
  /** Consensus estimates to compare against, if available. */
  consensusEPS: number | null;
  consensusRevenue: number | null;
  /** Previous quarter's guidance, if available, for comparison. */
  previousGuidance: GuidanceUpdate[] | null;
}

/** Raw LLM extraction result before post-processing. */
export interface LLMExtractionResult {
  revenueActual: number | null;
  epsActual: number | null;
  guidanceUpdates: GuidanceUpdate[];
  keyQuotes: KeyQuote[];
  segmentHighlights: SegmentHighlight[];
  riskFactors: RiskFactor[];
  overallTone: 'positive' | 'neutral' | 'negative';
}

// ---------------------------------------------------------------------------
// Structured-data extraction (no LLM required)
// ---------------------------------------------------------------------------

/**
 * Build a MetricComparison from an actual value and a consensus estimate.
 *
 * This is used both as a standalone function (when we have structured data
 * from the EarningsEvent type) and as a helper for the LLM pipeline.
 *
 * Beat/miss threshold: 1% of estimate (industry standard for "inline").
 */
export function compareMetric(
  actual: number | null,
  estimate: number | null,
  inlineThresholdPct: number = 1,
): MetricComparison {
  if (actual == null) {
    return {
      actual: null,
      estimate,
      surprise: null,
      surprisePercent: null,
      status: 'not_reported',
    };
  }

  if (estimate == null || estimate === 0) {
    return {
      actual,
      estimate,
      surprise: null,
      surprisePercent: null,
      status: 'not_reported',
    };
  }

  const surprise = actual - estimate;
  const surprisePercent = (surprise / Math.abs(estimate)) * 100;

  let status: BeatMissStatus;
  if (Math.abs(surprisePercent) <= inlineThresholdPct) {
    status = 'inline';
  } else if (surprise > 0) {
    status = 'beat';
  } else {
    status = 'miss';
  }

  return {
    actual,
    estimate,
    surprise: roundTo(surprise, 4),
    surprisePercent: roundTo(surprisePercent, 2),
    status,
  };
}

/**
 * Build an EarningsSummary from structured data sources (EarningsEvent +
 * CompanyFundamentals) without needing an LLM.
 *
 * This produces a partial summary (no quotes, segments, or risk factors)
 * but is deterministic and instantaneous.
 */
export function buildSummaryFromStructuredData(
  event: EarningsEvent,
  fundamentals?: CompanyFundamentals | null,
): EarningsSummary {
  const revenue = compareMetric(event.revenueActual ?? null, event.revenueEstimate ?? null);
  const eps = compareMetric(event.epsActual ?? null, event.epsEstimate ?? null);

  // Determine overall tone from the beat/miss status
  let overallTone: 'positive' | 'neutral' | 'negative' = 'neutral';
  const beatCount = [revenue.status, eps.status].filter((s) => s === 'beat').length;
  const missCount = [revenue.status, eps.status].filter((s) => s === 'miss').length;
  if (beatCount > missCount) overallTone = 'positive';
  else if (missCount > beatCount) overallTone = 'negative';

  return {
    instrumentId: event.instrumentId,
    fiscalPeriod: event.fiscalQuarter,
    processedAt: new Date().toISOString(),
    revenue,
    eps,
    guidanceUpdates: [],
    keyQuotes: [],
    segmentHighlights: [],
    riskFactors: [],
    overallTone,
    confidenceScore: computeStructuredConfidence(revenue, eps),
    method: 'structured-data',
  };
}

// ---------------------------------------------------------------------------
// Full LLM-powered extraction pipeline
// ---------------------------------------------------------------------------

export interface EarningsExtractionOptions {
  llmProvider?: EarningsLLMProvider;
  /** Timeout for LLM calls in milliseconds. Default 60000. */
  llmTimeoutMs?: number;
}

/**
 * Extract a structured earnings summary from a transcript or press release.
 *
 * Strategy:
 *   1. If an LLM provider is available, use it to extract qualitative data
 *      (quotes, guidance, segments, risks, tone).
 *   2. Always use structured data (EarningsEvent) for precise metric comparison
 *      to avoid LLM hallucination on exact numbers.
 *   3. Merge results from both paths.
 */
export async function extractEarningsSummary(
  transcriptText: string,
  event: EarningsEvent,
  context: EarningsExtractionContext,
  options: EarningsExtractionOptions = {},
): Promise<EarningsSummary> {
  const { llmProvider, llmTimeoutMs = 60_000 } = options;

  // Always compute metrics from structured data — more reliable than LLM
  const revenue = compareMetric(event.revenueActual ?? null, context.consensusRevenue);
  const eps = compareMetric(event.epsActual ?? null, context.consensusEPS);

  // Attempt LLM extraction for qualitative data
  let llmResult: LLMExtractionResult | null = null;
  let usedLLM = false;

  if (llmProvider) {
    try {
      const available = await llmProvider.isAvailable();
      if (available) {
        llmResult = await withTimeout(
          llmProvider.extractEarningsSummary(transcriptText, context),
          llmTimeoutMs,
        );
        usedLLM = true;
      }
    } catch {
      // Fall through — qualitative fields will be empty
      llmResult = null;
    }
  }

  // Determine overall tone
  let overallTone: 'positive' | 'neutral' | 'negative';
  if (llmResult) {
    overallTone = llmResult.overallTone;
  } else {
    const beatCount = [revenue.status, eps.status].filter((s) => s === 'beat').length;
    const missCount = [revenue.status, eps.status].filter((s) => s === 'miss').length;
    overallTone = beatCount > missCount ? 'positive' : missCount > beatCount ? 'negative' : 'neutral';
  }

  return {
    instrumentId: event.instrumentId,
    fiscalPeriod: event.fiscalQuarter,
    processedAt: new Date().toISOString(),
    revenue,
    eps,
    guidanceUpdates: llmResult?.guidanceUpdates ?? [],
    keyQuotes: llmResult?.keyQuotes ?? [],
    segmentHighlights: llmResult?.segmentHighlights ?? [],
    riskFactors: llmResult?.riskFactors ?? [],
    overallTone,
    confidenceScore: usedLLM ? 0.85 : computeStructuredConfidence(revenue, eps),
    method: usedLLM ? 'llm' : 'structured-data',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStructuredConfidence(
  revenue: MetricComparison,
  eps: MetricComparison,
): number {
  let confidence = 0.3; // Base confidence for structured data
  if (revenue.status !== 'not_reported') confidence += 0.25;
  if (eps.status !== 'not_reported') confidence += 0.25;
  if (revenue.actual != null && eps.actual != null) confidence += 0.1;
  return Math.min(1, confidence);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Earnings LLM timeout after ${ms}ms`)), ms);
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
