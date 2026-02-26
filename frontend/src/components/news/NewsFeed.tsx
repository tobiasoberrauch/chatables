'use client';

/**
 * NewsFeed
 *
 * Scrollable, real-time news feed with:
 *  - Sentiment badges (bullish/bearish/neutral)
 *  - Instrument ticker tags
 *  - Time-ago formatting (date-fns)
 *  - Click-to-expand article summary
 *  - Filtering by sentiment and instrument
 *  - WebSocket subscription for breaking news
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import clsx from 'clsx';
import Link from 'next/link';
import { getNews } from '@/services/api';
import { getWebSocketService } from '@/services/websocket';
import type { NewsArticle, PaginatedResponse, WSEvent } from '@/types';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface NewsFeedProps {
  /** Pre-filter to a specific instrument (e.g. on the instrument detail page). */
  instrumentId?: string;
  /** Maximum height of the scrollable area. */
  maxHeight?: string;
  /** Page size for paginated queries. */
  pageSize?: number;
}

type SentimentFilter = 'all' | 'bullish' | 'bearish' | 'neutral';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

function SentimentBadge({ label }: { label: NewsArticle['sentimentLabel'] }) {
  if (!label) return null;

  const classes: Record<string, string> = {
    bullish: 'badge-bullish',
    bearish: 'badge-bearish',
    neutral: 'badge-neutral',
  };

  return <span className={classes[label] ?? 'badge-neutral'}>{label}</span>;
}

/* ------------------------------------------------------------------ */
/*  NewsItem                                                          */
/* ------------------------------------------------------------------ */

function NewsItem({ article }: { article: NewsArticle }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article
      className="group cursor-pointer border-b border-terminal-border/50 px-4 py-3 transition-colors hover:bg-terminal-bg-hover"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-3">
        {/* Sentiment + source */}
        <div className="flex flex-shrink-0 flex-col items-start gap-1.5 pt-0.5">
          <SentimentBadge label={article.sentimentLabel} />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium leading-snug text-terminal-text group-hover:text-terminal-accent">
            {article.title}
          </h4>

          {/* Expanded summary */}
          {expanded && article.summary && (
            <p className="mt-2 text-xs leading-relaxed text-terminal-text-secondary">
              {article.summary}
            </p>
          )}

          {/* Meta row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xxs text-terminal-text-muted">
            <span className="font-semibold uppercase">{article.source}</span>
            <span>&middot;</span>
            <time dateTime={article.publishedAt}>{timeAgo(article.publishedAt)}</time>

            {/* Ticker tags */}
            {article.tickers.length > 0 && (
              <>
                <span>&middot;</span>
                <div className="flex gap-1">
                  {article.tickers.slice(0, 5).map((t) => (
                    <Link
                      key={t}
                      href={`/instrument/${t}`}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded bg-terminal-bg-elevated px-1.5 py-0.5 font-mono text-xxs font-semibold text-terminal-accent hover:bg-terminal-accent-bg"
                    >
                      {t}
                    </Link>
                  ))}
                </div>
              </>
            )}

            {/* External link */}
            {article.url && (
              <>
                <span className="ml-auto" />
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-terminal-accent hover:underline"
                >
                  Source &rarr;
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function NewsFeed({
  instrumentId,
  maxHeight = '700px',
  pageSize = 30,
}: NewsFeedProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all');
  const [page, setPage] = useState(1);

  // Fetch news
  const { data, isLoading, isFetching } = useQuery<PaginatedResponse<NewsArticle>>({
    queryKey: ['news', instrumentId, sentimentFilter, page, pageSize],
    queryFn: () =>
      getNews({
        instrumentId,
        sentiment: sentimentFilter === 'all' ? undefined : sentimentFilter,
        page,
        pageSize,
      }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const articles = data?.data ?? [];
  const pagination = data?.pagination;

  // Real-time news via WebSocket
  useEffect(() => {
    const ws = getWebSocketService();
    ws.connect();

    const channel = instrumentId ? `news.${instrumentId}` : 'news.all';
    const unsub = ws.subscribe<NewsArticle>(channel, (event: WSEvent<NewsArticle>) => {
      // Prepend new article to the cache
      queryClient.setQueryData<PaginatedResponse<NewsArticle>>(
        ['news', instrumentId, sentimentFilter, 1, pageSize],
        (old) => {
          if (!old) return old as unknown as PaginatedResponse<NewsArticle>;
          return {
            ...old,
            data: [event.data, ...old.data.slice(0, pageSize - 1)],
            pagination: {
              ...old.pagination,
              totalItems: old.pagination.totalItems + 1,
            },
          };
        },
      );
    });

    return unsub;
  }, [instrumentId, sentimentFilter, pageSize, queryClient]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [sentimentFilter, instrumentId]);

  const handleFilterChange = useCallback((f: SentimentFilter) => {
    setSentimentFilter(f);
  }, []);

  const sentimentOptions: { label: string; value: SentimentFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Bullish', value: 'bullish' },
    { label: 'Bearish', value: 'bearish' },
    { label: 'Neutral', value: 'neutral' },
  ];

  return (
    <div className="terminal-card-flush flex flex-col">
      {/* Header + filters */}
      <div className="flex flex-wrap items-center gap-3 border-b border-terminal-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
          News Feed
        </h3>

        <div className="ml-auto flex gap-1">
          {sentimentOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFilterChange(opt.value)}
              className={clsx(
                'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
                sentimentFilter === opt.value
                  ? 'bg-terminal-accent-bg text-terminal-accent'
                  : 'text-terminal-text-muted hover:text-terminal-text',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Loading indicator */}
        {isFetching && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-terminal-accent" />
        )}
      </div>

      {/* Articles list */}
      <div
        ref={scrollRef}
        className="terminal-scroll"
        style={{ maxHeight }}
      >
        {isLoading && articles.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-terminal-text-muted">
            Loading news...
          </div>
        ) : articles.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-terminal-text-muted">
            No articles found
          </div>
        ) : (
          articles.map((article) => (
            <NewsItem key={article.id} article={article} />
          ))
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-terminal-border px-4 py-2">
          <span className="text-xxs text-terminal-text-muted">
            Page {pagination.page} of {pagination.totalPages} ({pagination.totalItems} articles)
          </span>
          <div className="flex gap-2">
            <button
              disabled={!pagination.hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded bg-terminal-bg-elevated px-2.5 py-1 text-xxs font-semibold text-terminal-text-secondary transition-colors hover:bg-terminal-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <button
              disabled={!pagination.hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="rounded bg-terminal-bg-elevated px-2.5 py-1 text-xxs font-semibold text-terminal-text-secondary transition-colors hover:bg-terminal-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
