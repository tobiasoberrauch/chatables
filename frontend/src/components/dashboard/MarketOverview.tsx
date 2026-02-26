'use client';

/**
 * MarketOverview
 *
 * Primary dashboard view — Bloomberg-terminal style grid showing:
 *  - Major indices strip
 *  - Top gainers / losers tables
 *  - Sector performance heatmap
 *
 * All panels update in real time via WebSocket.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import clsx from 'clsx';
import { getIndices, getSectorPerformance, getTopMovers } from '@/services/api';
import type { Mover, QuoteSummary, SectorPerformance } from '@/types';
import { useMarketDataBatch } from '@/hooks/useMarketData';

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function formatNum(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function formatVolume(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function PriceChange({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={clsx(
        'font-mono',
        value > 0 && 'text-terminal-gain',
        value < 0 && 'text-terminal-loss',
        value === 0 && 'text-terminal-text-muted',
        className,
      )}
    >
      {formatPct(value)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Indices Strip                                                     */
/* ------------------------------------------------------------------ */

function IndicesStrip({ indices }: { indices: QuoteSummary[] }) {
  const ids = indices.map((i) => i.instrumentId);
  const liveData = useMarketDataBatch(ids);

  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {indices.map((idx) => {
        const live = liveData.get(idx.instrumentId);
        const price = live?.price ?? idx.lastPrice;
        const changePct = live?.changePct ?? idx.changePct;
        const direction = live?.direction ?? (idx.changePct > 0 ? 'up' : idx.changePct < 0 ? 'down' : 'flat');

        return (
          <div
            key={idx.instrumentId}
            className={clsx(
              'terminal-card flex min-w-[180px] flex-col gap-1 px-4 py-3',
              direction === 'up' && 'border-terminal-gain/30',
              direction === 'down' && 'border-terminal-loss/30',
            )}
          >
            <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted">
              {idx.ticker}
            </span>
            <span className="font-mono text-lg font-bold text-terminal-text">
              {formatNum(price)}
            </span>
            <PriceChange value={changePct} className="text-xs" />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Movers Table                                                      */
/* ------------------------------------------------------------------ */

function MoversTable({
  title,
  movers,
}: {
  title: string;
  movers: Mover[];
}) {
  return (
    <div className="terminal-card-flush flex flex-col">
      <div className="border-b border-terminal-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
          {title}
        </h3>
      </div>
      <div className="terminal-scroll max-h-[340px]">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th className="text-right">Price</th>
              <th className="text-right">Chg %</th>
              <th className="text-right">Volume</th>
            </tr>
          </thead>
          <tbody>
            {movers.map((m) => (
              <tr key={m.instrumentId}>
                <td>
                  <Link
                    href={`/instrument/${m.instrumentId}`}
                    className="font-semibold text-terminal-accent hover:underline"
                  >
                    {m.ticker}
                  </Link>
                  <div className="mt-0.5 truncate text-xxs text-terminal-text-muted">
                    {m.name}
                  </div>
                </td>
                <td className="text-right font-mono">{formatNum(m.lastPrice)}</td>
                <td className="text-right">
                  <PriceChange value={m.changePct} />
                </td>
                <td className="text-right font-mono text-terminal-text-secondary">
                  {formatVolume(m.volume)}
                </td>
              </tr>
            ))}
            {movers.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-terminal-text-muted">
                  No data available
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sector Heatmap                                                    */
/* ------------------------------------------------------------------ */

function SectorHeatmap({ sectors }: { sectors: SectorPerformance[] }) {
  const sorted = [...sectors].sort((a, b) => b.changePct - a.changePct);
  const maxAbs = Math.max(...sorted.map((s) => Math.abs(s.changePct)), 1);

  return (
    <div className="terminal-card-flush flex flex-col">
      <div className="border-b border-terminal-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
          Sector Performance
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-px bg-terminal-border p-px sm:grid-cols-3 lg:grid-cols-4">
        {sorted.map((sector) => {
          const intensity = Math.min(Math.abs(sector.changePct) / maxAbs, 1);
          const bgColor =
            sector.changePct > 0
              ? `rgba(0, 200, 83, ${0.08 + intensity * 0.18})`
              : sector.changePct < 0
                ? `rgba(255, 23, 68, ${0.08 + intensity * 0.18})`
                : 'transparent';

          return (
            <div
              key={sector.sector}
              className="flex flex-col items-center justify-center bg-terminal-bg-secondary p-3 transition-colors hover:bg-terminal-bg-hover"
              style={{ backgroundColor: bgColor }}
            >
              <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-secondary">
                {sector.sector}
              </span>
              <PriceChange value={sector.changePct} className="mt-1 text-sm font-bold" />
              <span className="mt-0.5 text-xxs text-terminal-text-muted">
                {sector.leadingTicker} {formatPct(sector.leadingChangePct)}
              </span>
            </div>
          );
        })}
        {sectors.length === 0 && (
          <div className="col-span-full py-8 text-center text-terminal-text-muted">
            No sector data
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function MarketOverview() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: indices = [] } = useQuery<QuoteSummary[]>({
    queryKey: ['indices'],
    queryFn: getIndices,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: gainers = [] } = useQuery<Mover[]>({
    queryKey: ['movers', 'gainers'],
    queryFn: () => getTopMovers({ direction: 'gainers', limit: 10 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: losers = [] } = useQuery<Mover[]>({
    queryKey: ['movers', 'losers'],
    queryFn: () => getTopMovers({ direction: 'losers', limit: 10 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: sectors = [] } = useQuery<SectorPerformance[]>({
    queryKey: ['sectors'],
    queryFn: getSectorPerformance,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (!mounted) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-terminal-text">Market Overview</h1>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-terminal-gain" />
          <span className="text-xxs uppercase tracking-wider text-terminal-text-muted">
            Live
          </span>
        </div>
      </div>

      {/* Indices strip */}
      <IndicesStrip indices={indices} />

      {/* Movers + Sectors grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MoversTable title="Top Gainers" movers={gainers} />
        <MoversTable title="Top Losers" movers={losers} />
        <SectorHeatmap sectors={sectors} />
      </div>
    </div>
  );
}
