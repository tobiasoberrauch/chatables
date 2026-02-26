'use client';

/**
 * CompanyProfile
 *
 * Comprehensive company information page:
 *  - Header: ticker, name, live price, change, sparkline indication
 *  - Key stats grid: market cap, P/E, EPS, dividend yield, etc.
 *  - Earnings history bar chart (recharts)
 *  - Company news feed (re-uses NewsFeed component)
 *  - Fundamentals detail table
 */

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';

import { useMarketData } from '@/hooks/useMarketData';
import { getEarnings, getFundamentals, getInstrument } from '@/services/api';
import type { CompanyFundamentals, EarningsEvent, Instrument } from '@/types';
import NewsFeed from '@/components/news/NewsFeed';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface CompanyProfileProps {
  instrumentId: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatLargeNumber(n: number | null): string {
  if (n === null || n === undefined) return '\u2014';
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString('en-US');
}

function formatRatio(n: number | null, suffix = ''): string {
  if (n === null || n === undefined) return '\u2014';
  return `${n.toFixed(2)}${suffix}`;
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-terminal-border/50 bg-terminal-bg-tertiary px-3 py-2">
      <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted">
        {label}
      </span>
      <span className="font-mono text-sm font-bold text-terminal-text">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Earnings Chart                                                    */
/* ------------------------------------------------------------------ */

function EarningsChart({ earnings }: { earnings: EarningsEvent[] }) {
  if (earnings.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-terminal-text-muted">
        No earnings data available
      </div>
    );
  }

  const chartData = [...earnings]
    .reverse()
    .map((e) => ({
      quarter: e.fiscalQuarter,
      actual: e.epsActual,
      estimate: e.epsEstimate,
      surprise: e.surprise,
      beat: e.epsActual !== null && e.epsEstimate !== null && e.epsActual > e.epsEstimate,
    }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1a1a24" />
        <XAxis
          dataKey="quarter"
          tick={{ fill: '#6e6e82', fontSize: 10, fontFamily: '"JetBrains Mono", monospace' }}
          axisLine={{ stroke: '#2e2e3e' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#6e6e82', fontSize: 10, fontFamily: '"JetBrains Mono", monospace' }}
          axisLine={{ stroke: '#2e2e3e' }}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1a24',
            border: '1px solid #2e2e3e',
            borderRadius: 6,
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
          }}
          labelStyle={{ color: '#a0a0b0' }}
          itemStyle={{ color: '#e8e8ed' }}
        />
        <ReferenceLine y={0} stroke="#2e2e3e" />

        {/* Estimate bars (behind) */}
        <Bar dataKey="estimate" name="Estimate" fill="#448aff40" radius={[2, 2, 0, 0]} />

        {/* Actual bars */}
        <Bar dataKey="actual" name="Actual" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.beat ? '#00c853' : '#ff1744'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ */
/*  Fundamentals Table                                                */
/* ------------------------------------------------------------------ */

function FundamentalsTable({ data }: { data: CompanyFundamentals }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Report Date', value: data.reportDate },
    { label: 'Period', value: `${data.period} ${data.fiscalYear}` },
    { label: 'Revenue', value: formatLargeNumber(data.revenue) },
    { label: 'Net Income', value: formatLargeNumber(data.netIncome) },
    { label: 'EPS', value: formatRatio(data.eps) },
    { label: 'EPS Estimate', value: formatRatio(data.epsEstimate) },
    { label: 'P/E Ratio', value: formatRatio(data.peRatio, 'x') },
    { label: 'P/B Ratio', value: formatRatio(data.pbRatio, 'x') },
    { label: 'Debt to Equity', value: formatRatio(data.debtToEquity) },
    { label: 'Dividend Yield', value: data.dividendYield !== null ? `${(data.dividendYield * 100).toFixed(2)}%` : '\u2014' },
    { label: 'Free Cash Flow', value: formatLargeNumber(data.freeCashFlow) },
  ];

  return (
    <table className="terminal-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th className="text-right">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td className="!font-sans text-terminal-text-secondary">{row.label}</td>
            <td className="text-right font-mono text-terminal-text">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function CompanyProfile({ instrumentId }: CompanyProfileProps) {
  const live = useMarketData(instrumentId);

  const { data: instrument } = useQuery<Instrument>({
    queryKey: ['instrument', instrumentId],
    queryFn: () => getInstrument(instrumentId),
    staleTime: 300_000,
  });

  const { data: fundamentals } = useQuery<CompanyFundamentals>({
    queryKey: ['fundamentals', instrumentId],
    queryFn: () => getFundamentals(instrumentId),
    staleTime: 300_000,
  });

  const { data: earnings = [] } = useQuery<EarningsEvent[]>({
    queryKey: ['earnings', instrumentId],
    queryFn: () => getEarnings(instrumentId, 8),
    staleTime: 300_000,
  });

  const displayName = instrument?.name ?? live.name;
  const displayTicker = instrument?.primaryTicker ?? live.ticker;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Header ---- */}
      <div className="terminal-card flex flex-wrap items-end gap-4">
        <div className="flex flex-col">
          <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted">
            {instrument?.type} &middot; {instrument?.primaryExchangeMic}
          </span>
          <h1 className="text-xl font-bold text-terminal-text">
            {displayTicker}{' '}
            <span className="font-normal text-terminal-text-secondary">{displayName}</span>
          </h1>
        </div>

        <div className="ml-auto flex items-end gap-4">
          {/* Live price */}
          <div className="text-right">
            <div className="font-mono text-2xl font-bold text-terminal-text">
              {live.isLoading ? (
                <span className="animate-pulse text-terminal-text-muted">---.--</span>
              ) : (
                live.price.toFixed(2)
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <span
                className={clsx(
                  'font-mono text-sm font-semibold',
                  live.change > 0 && 'text-terminal-gain',
                  live.change < 0 && 'text-terminal-loss',
                  live.change === 0 && 'text-terminal-text-muted',
                )}
              >
                {live.change > 0 ? '+' : ''}{live.change.toFixed(2)}
              </span>
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
                  live.changePct > 0 && 'bg-terminal-gain-bg text-terminal-gain',
                  live.changePct < 0 && 'bg-terminal-loss-bg text-terminal-loss',
                  live.changePct === 0 && 'bg-terminal-bg-elevated text-terminal-text-muted',
                )}
              >
                {live.changePct > 0 ? '+' : ''}{live.changePct.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Key Stats Grid ---- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatBox label="Market Cap" value={formatLargeNumber(fundamentals?.marketCap ?? null)} />
        <StatBox label="P/E Ratio" value={formatRatio(fundamentals?.peRatio ?? null, 'x')} />
        <StatBox label="EPS" value={formatRatio(fundamentals?.eps ?? null)} />
        <StatBox
          label="Div Yield"
          value={
            fundamentals?.dividendYield !== null && fundamentals?.dividendYield !== undefined
              ? `${(fundamentals.dividendYield * 100).toFixed(2)}%`
              : '\u2014'
          }
        />
        <StatBox label="Volume" value={formatLargeNumber(live.volume)} />
        <StatBox
          label="Day Range"
          value={live.low && live.high ? `${live.low.toFixed(2)} - ${live.high.toFixed(2)}` : '\u2014'}
        />
      </div>

      {/* ---- Two-column: Earnings + Fundamentals ---- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Earnings */}
        <div className="terminal-card-flush">
          <div className="border-b border-terminal-border px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
              Earnings History
            </h3>
          </div>
          <div className="p-4">
            <EarningsChart earnings={earnings} />
          </div>
        </div>

        {/* Fundamentals */}
        <div className="terminal-card-flush">
          <div className="border-b border-terminal-border px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text-muted">
              Fundamentals
            </h3>
          </div>
          {fundamentals ? (
            <FundamentalsTable data={fundamentals} />
          ) : (
            <div className="flex items-center justify-center py-12 text-terminal-text-muted">
              Loading fundamentals...
            </div>
          )}
        </div>
      </div>

      {/* ---- News for this instrument ---- */}
      <div>
        <NewsFeed instrumentId={instrumentId} maxHeight="400px" pageSize={15} />
      </div>
    </div>
  );
}
