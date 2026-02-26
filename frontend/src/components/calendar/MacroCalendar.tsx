'use client';

/**
 * MacroCalendar
 *
 * Economic calendar view:
 *  - Table layout with upcoming macroeconomic events
 *  - Country flags (emoji-based for zero dependencies)
 *  - Impact indicators (coloured dots: high=red, medium=amber, low=grey)
 *  - Actual vs. forecast values with surprise highlighting
 *  - Date range picker (simple select-based)
 *  - Category filter
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, addDays, startOfDay, parseISO } from 'date-fns';
import clsx from 'clsx';
import { getCalendar } from '@/services/api';
import type { MacroCategory, MacroEvent, PaginatedResponse } from '@/types';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const COUNTRY_FLAGS: Record<string, string> = {
  US: '\u{1F1FA}\u{1F1F8}',
  GB: '\u{1F1EC}\u{1F1E7}',
  EU: '\u{1F1EA}\u{1F1FA}',
  JP: '\u{1F1EF}\u{1F1F5}',
  CN: '\u{1F1E8}\u{1F1F3}',
  DE: '\u{1F1E9}\u{1F1EA}',
  FR: '\u{1F1EB}\u{1F1F7}',
  CA: '\u{1F1E8}\u{1F1E6}',
  AU: '\u{1F1E6}\u{1F1FA}',
  CH: '\u{1F1E8}\u{1F1ED}',
  NZ: '\u{1F1F3}\u{1F1FF}',
  IN: '\u{1F1EE}\u{1F1F3}',
  BR: '\u{1F1E7}\u{1F1F7}',
  KR: '\u{1F1F0}\u{1F1F7}',
};

const CATEGORIES: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Employment', value: 'EMPLOYMENT' },
  { label: 'Inflation', value: 'INFLATION' },
  { label: 'GDP', value: 'GDP' },
  { label: 'Central Bank', value: 'CENTRAL_BANK' },
  { label: 'Housing', value: 'HOUSING' },
  { label: 'Manufacturing', value: 'MANUFACTURING' },
  { label: 'Consumer', value: 'CONSUMER' },
  { label: 'Trade', value: 'TRADE' },
];

const IMPACT_FILTERS = [
  { label: 'All', value: '' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

type DateRange = 'today' | 'week' | 'month';

const DATE_RANGES: { label: string; value: DateRange }[] = [
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function getDateRange(range: DateRange): { from: string; to: string } {
  const now = startOfDay(new Date());
  switch (range) {
    case 'today':
      return { from: now.toISOString(), to: addDays(now, 1).toISOString() };
    case 'week':
      return { from: now.toISOString(), to: addDays(now, 7).toISOString() };
    case 'month':
      return { from: now.toISOString(), to: addDays(now, 30).toISOString() };
  }
}

function ImpactDot({ impact }: { impact: MacroEvent['impact'] }) {
  const cls: Record<string, string> = {
    high: 'impact-high',
    medium: 'impact-medium',
    low: 'impact-low',
  };

  return (
    <span className="flex items-center gap-1.5">
      <span className={cls[impact] ?? cls.low} />
      <span className="text-xxs uppercase text-terminal-text-muted">{impact}</span>
    </span>
  );
}

function SurpriseValue({
  actual,
  forecast,
  unit,
}: {
  actual: number | null;
  forecast: number | null;
  unit: string;
}) {
  if (actual === null) {
    return <span className="text-terminal-text-dim">&mdash;</span>;
  }

  const surprise = forecast !== null ? actual - forecast : null;

  return (
    <span className="flex items-center gap-1.5 font-mono">
      <span
        className={clsx(
          'font-semibold',
          surprise !== null && surprise > 0 && 'text-terminal-gain',
          surprise !== null && surprise < 0 && 'text-terminal-loss',
          surprise === null && 'text-terminal-text',
        )}
      >
        {actual.toFixed(1)}{unit}
      </span>
      {surprise !== null && surprise !== 0 && (
        <span
          className={clsx(
            'text-xxs',
            surprise > 0 ? 'text-terminal-gain' : 'text-terminal-loss',
          )}
        >
          ({surprise > 0 ? '+' : ''}{surprise.toFixed(1)})
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function MacroCalendar() {
  const [dateRange, setDateRange] = useState<DateRange>('week');
  const [category, setCategory] = useState('');
  const [impact, setImpact] = useState('');
  const [page, setPage] = useState(1);

  const { from, to } = useMemo(() => getDateRange(dateRange), [dateRange]);

  const { data, isLoading } = useQuery<PaginatedResponse<MacroEvent>>({
    queryKey: ['calendar', from, to, category, impact, page],
    queryFn: () =>
      getCalendar({
        from,
        to,
        category: category || undefined,
        impact: impact || undefined,
        page,
        pageSize: 50,
      }),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const events = data?.data ?? [];
  const pagination = data?.pagination;

  // Group events by date
  const groupedEvents = useMemo(() => {
    const groups = new Map<string, MacroEvent[]>();
    for (const event of events) {
      const dateKey = format(parseISO(event.scheduledAt), 'yyyy-MM-dd');
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey)!.push(event);
    }
    return groups;
  }, [events]);

  return (
    <div className="terminal-card-flush flex flex-col">
      {/* Header with filters */}
      <div className="flex flex-wrap items-center gap-3 border-b border-terminal-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
          Economic Calendar
        </h3>

        {/* Date range */}
        <div className="ml-auto flex gap-1">
          {DATE_RANGES.map((dr) => (
            <button
              key={dr.value}
              onClick={() => { setDateRange(dr.value); setPage(1); }}
              className={clsx(
                'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
                dateRange === dr.value
                  ? 'bg-terminal-accent-bg text-terminal-accent'
                  : 'text-terminal-text-muted hover:text-terminal-text',
              )}
            >
              {dr.label}
            </button>
          ))}
        </div>

        {/* Category select */}
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          className="rounded border border-terminal-border bg-terminal-bg-elevated px-2 py-1 text-xxs text-terminal-text-secondary focus:border-terminal-accent focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        {/* Impact filter */}
        <div className="flex gap-1">
          {IMPACT_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setImpact(f.value); setPage(1); }}
              className={clsx(
                'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
                impact === f.value
                  ? 'bg-terminal-accent-bg text-terminal-accent'
                  : 'text-terminal-text-muted hover:text-terminal-text',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="terminal-scroll max-h-[700px]">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-terminal-text-muted">
            Loading calendar...
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-terminal-text-muted">
            No events found
          </div>
        ) : (
          <table className="terminal-table">
            <thead>
              <tr>
                <th className="w-[80px]">Time</th>
                <th className="w-[40px]"></th>
                <th>Event</th>
                <th className="w-[70px] text-center">Impact</th>
                <th className="w-[90px] text-right">Actual</th>
                <th className="w-[90px] text-right">Forecast</th>
                <th className="w-[90px] text-right">Previous</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(groupedEvents.entries()).map(([dateKey, dayEvents]) => (
                <>
                  {/* Date header row */}
                  <tr key={`header-${dateKey}`}>
                    <td
                      colSpan={7}
                      className="bg-terminal-bg-tertiary !px-4 !py-2 !font-sans text-xxs font-bold uppercase tracking-wider text-terminal-text-muted"
                    >
                      {format(parseISO(dateKey), 'EEEE, MMM d, yyyy')}
                    </td>
                  </tr>

                  {dayEvents.map((event) => (
                    <tr key={event.id}>
                      <td className="text-terminal-text-secondary">
                        {format(parseISO(event.scheduledAt), 'HH:mm')}
                      </td>
                      <td className="text-center">
                        <span title={event.country}>
                          {COUNTRY_FLAGS[event.country] ?? event.country}
                        </span>
                      </td>
                      <td className="!font-sans text-terminal-text">
                        <span className="font-medium">{event.name}</span>
                        <span className="ml-2 text-xxs uppercase text-terminal-text-dim">
                          {event.category}
                        </span>
                      </td>
                      <td className="text-center">
                        <ImpactDot impact={event.impact} />
                      </td>
                      <td className="text-right">
                        <SurpriseValue
                          actual={event.actual}
                          forecast={event.forecast}
                          unit={event.unit}
                        />
                      </td>
                      <td className="text-right font-mono text-terminal-text-secondary">
                        {event.forecast !== null ? `${event.forecast.toFixed(1)}${event.unit}` : '\u2014'}
                      </td>
                      <td className="text-right font-mono text-terminal-text-muted">
                        {event.previous !== null ? `${event.previous.toFixed(1)}${event.unit}` : '\u2014'}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-terminal-border px-4 py-2">
          <span className="text-xxs text-terminal-text-muted">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              disabled={!pagination.hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded bg-terminal-bg-elevated px-2.5 py-1 text-xxs font-semibold text-terminal-text-secondary hover:bg-terminal-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <button
              disabled={!pagination.hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="rounded bg-terminal-bg-elevated px-2.5 py-1 text-xxs font-semibold text-terminal-text-secondary hover:bg-terminal-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
