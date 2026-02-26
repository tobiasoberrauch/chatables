'use client';

/**
 * PriceChart
 *
 * Interactive candlestick / line chart built on TradingView lightweight-charts.
 *
 * Capabilities:
 *  - Candlestick or line mode
 *  - Multiple timeframes (1m, 5m, 15m, 1h, 1d)
 *  - Volume histogram sub-series
 *  - Crosshair with price legend
 *  - Responsive container sizing
 *  - Technical indicator overlays delegated to <IndicatorOverlay />
 *  - Real-time tick updates via WebSocket
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type HistogramData,
  type Time,
  ColorType,
  CrosshairMode,
  LineStyle,
  type DeepPartial,
  type ChartOptions,
} from 'lightweight-charts';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { getBars } from '@/services/api';
import { useMarketData } from '@/hooks/useMarketData';
import type { BarSize, OHLCVBar } from '@/types';
import IndicatorOverlay, { type IndicatorConfig } from './IndicatorOverlay';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface PriceChartProps {
  instrumentId: string;
  ticker?: string;
  className?: string;
  defaultBarSize?: BarSize;
  height?: number;
}

type ChartMode = 'candle' | 'line';

interface TimeframeOption {
  label: string;
  barSize: BarSize;
  daysBack: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const TIMEFRAMES: TimeframeOption[] = [
  { label: '1m', barSize: '1m' as BarSize, daysBack: 1 },
  { label: '5m', barSize: '5m' as BarSize, daysBack: 3 },
  { label: '15m', barSize: '15m' as BarSize, daysBack: 7 },
  { label: '1H', barSize: '1h' as BarSize, daysBack: 30 },
  { label: '1D', barSize: '1d' as BarSize, daysBack: 365 },
];

const AVAILABLE_INDICATORS: IndicatorConfig[] = [
  { id: 'sma-20', indicator: 'sma', label: 'SMA 20', params: { period: 20 }, color: '#448aff', overlay: true },
  { id: 'sma-50', indicator: 'sma', label: 'SMA 50', params: { period: 50 }, color: '#ffab00', overlay: true },
  { id: 'ema-12', indicator: 'ema', label: 'EMA 12', params: { period: 12 }, color: '#00e5ff', overlay: true },
  { id: 'ema-26', indicator: 'ema', label: 'EMA 26', params: { period: 26 }, color: '#e040fb', overlay: true },
  { id: 'rsi-14', indicator: 'rsi', label: 'RSI 14', params: { period: 14 }, color: '#ffab00', overlay: false },
  { id: 'macd', indicator: 'macd', label: 'MACD', params: { fast: 12, slow: 26, signal: 9 }, color: '#448aff', overlay: false },
];

const CHART_COLORS = {
  background: '#111116',
  textColor: '#6e6e82',
  gridColor: '#1a1a24',
  borderColor: '#2e2e3e',
  crosshairColor: '#448aff',
  upColor: '#00c853',
  downColor: '#ff1744',
  volumeUp: 'rgba(0, 200, 83, 0.25)',
  volumeDown: 'rgba(255, 23, 68, 0.25)',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function toChartTime(iso: string): Time {
  // lightweight-charts expects UTC timestamp in seconds
  return Math.floor(new Date(iso).getTime() / 1000) as Time;
}

function barsToCandlestick(bars: OHLCVBar[]): CandlestickData[] {
  return bars.map((b) => ({
    time: toChartTime(b.timestamp),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

function barsToLine(bars: OHLCVBar[]): LineData[] {
  return bars.map((b) => ({
    time: toChartTime(b.timestamp),
    value: b.close,
  }));
}

function barsToVolume(bars: OHLCVBar[]): HistogramData[] {
  return bars.map((b) => ({
    time: toChartTime(b.timestamp),
    value: b.volume,
    color: b.close >= b.open ? CHART_COLORS.volumeUp : CHART_COLORS.volumeDown,
  }));
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function PriceChart({
  instrumentId,
  ticker,
  className,
  defaultBarSize,
  height = 500,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [mode, setMode] = useState<ChartMode>('candle');
  const [activeTimeframe, setActiveTimeframe] = useState<TimeframeOption>(
    TIMEFRAMES.find((t) => t.barSize === defaultBarSize) ?? TIMEFRAMES[4],
  );
  const [activeIndicators, setActiveIndicators] = useState<Set<string>>(new Set());
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);

  // Live data for latest tick
  const live = useMarketData(instrumentId);

  // Compute date range
  const { start } = useMemo(() => {
    const end = new Date();
    const s = new Date();
    s.setDate(s.getDate() - activeTimeframe.daysBack);
    return { start: s.toISOString(), end: end.toISOString() };
  }, [activeTimeframe]);

  // Fetch bars
  const { data: bars = [] } = useQuery({
    queryKey: ['bars', instrumentId, activeTimeframe.barSize, start],
    queryFn: () =>
      getBars({
        instrumentId,
        barSize: activeTimeframe.barSize,
        start,
        adjusted: true,
        limit: 1000,
      }),
    staleTime: activeTimeframe.barSize === ('1d' as BarSize) ? 300_000 : 30_000,
  });

  // ------------------------------------------------------------------
  // Create chart once
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    const chartOptions: DeepPartial<ChartOptions> = {
      layout: {
        background: { type: ColorType.Solid, color: CHART_COLORS.background },
        textColor: CHART_COLORS.textColor,
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: CHART_COLORS.gridColor, style: LineStyle.Dotted },
        horzLines: { color: CHART_COLORS.gridColor, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_COLORS.crosshairColor, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.crosshairColor },
        horzLine: { color: CHART_COLORS.crosshairColor, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.crosshairColor },
      },
      rightPriceScale: {
        borderColor: CHART_COLORS.borderColor,
        scaleMargins: { top: 0.05, bottom: 0.2 },
      },
      timeScale: {
        borderColor: CHART_COLORS.borderColor,
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    };

    const chart = createChart(containerRef.current, {
      ...chartOptions,
      width: containerRef.current.clientWidth,
      height,
    });

    chartRef.current = chart;

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor: CHART_COLORS.upColor,
      downColor: CHART_COLORS.downColor,
      borderUpColor: CHART_COLORS.upColor,
      borderDownColor: CHART_COLORS.downColor,
      wickUpColor: CHART_COLORS.upColor,
      wickDownColor: CHART_COLORS.downColor,
    });
    candleSeriesRef.current = candleSeries;

    // Line series (hidden by default)
    const lineSeries = chart.addLineSeries({
      color: CHART_COLORS.upColor,
      lineWidth: 2,
      visible: false,
    });
    lineSeriesRef.current = lineSeries;

    // Volume series
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // Resize observer
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      lineSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // ------------------------------------------------------------------
  // Update data when bars change
  // ------------------------------------------------------------------
  useEffect(() => {
    if (bars.length === 0) return;

    candleSeriesRef.current?.setData(barsToCandlestick(bars));
    lineSeriesRef.current?.setData(barsToLine(bars));
    volumeSeriesRef.current?.setData(barsToVolume(bars));

    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // ------------------------------------------------------------------
  // Toggle candle / line visibility
  // ------------------------------------------------------------------
  useEffect(() => {
    candleSeriesRef.current?.applyOptions({ visible: mode === 'candle' });
    lineSeriesRef.current?.applyOptions({ visible: mode === 'line' });
  }, [mode]);

  // ------------------------------------------------------------------
  // Real-time tick updates
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!live.price || live.isLoading || bars.length === 0) return;

    const time = toChartTime(live.updatedAt || new Date().toISOString());
    const lastBar = bars[bars.length - 1];

    if (mode === 'candle' && candleSeriesRef.current) {
      candleSeriesRef.current.update({
        time,
        open: lastBar.open,
        high: Math.max(lastBar.high, live.price),
        low: Math.min(lastBar.low, live.price),
        close: live.price,
      });
    }

    if (mode === 'line' && lineSeriesRef.current) {
      lineSeriesRef.current.update({ time, value: live.price });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.price, live.updatedAt]);

  // ------------------------------------------------------------------
  // Indicator toggle
  // ------------------------------------------------------------------
  const toggleIndicator = useCallback((id: string) => {
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const activeIndicatorConfigs = useMemo(
    () => AVAILABLE_INDICATORS.filter((i) => activeIndicators.has(i.id)),
    [activeIndicators],
  );

  // ------------------------------------------------------------------
  // Crosshair legend
  // ------------------------------------------------------------------
  const [crosshairData, setCrosshairData] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setCrosshairData(null);
        return;
      }

      const candle = param.seriesData.get(candleSeriesRef.current!) as CandlestickData | undefined;
      const vol = param.seriesData.get(volumeSeriesRef.current!) as HistogramData | undefined;

      if (candle) {
        setCrosshairData({
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: vol?.value ?? 0,
        });
      }
    });
  }, []);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className={clsx('terminal-card-flush flex flex-col', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-4 py-2">
        {/* Ticker label */}
        <span className="mr-2 font-mono text-sm font-bold text-terminal-text">
          {ticker ?? instrumentId}
        </span>

        {/* Timeframe pills */}
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.label}
              onClick={() => setActiveTimeframe(tf)}
              className={clsx(
                'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
                activeTimeframe.barSize === tf.barSize
                  ? 'bg-terminal-accent-bg text-terminal-accent'
                  : 'text-terminal-text-muted hover:text-terminal-text',
              )}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="mx-2 h-4 w-px bg-terminal-border" />

        {/* Chart mode toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setMode('candle')}
            className={clsx(
              'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
              mode === 'candle'
                ? 'bg-terminal-accent-bg text-terminal-accent'
                : 'text-terminal-text-muted hover:text-terminal-text',
            )}
          >
            Candle
          </button>
          <button
            onClick={() => setMode('line')}
            className={clsx(
              'rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider transition-colors',
              mode === 'line'
                ? 'bg-terminal-accent-bg text-terminal-accent'
                : 'text-terminal-text-muted hover:text-terminal-text',
            )}
          >
            Line
          </button>
        </div>

        <div className="mx-2 h-4 w-px bg-terminal-border" />

        {/* Indicators dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowIndicatorMenu((v) => !v)}
            className="rounded px-2 py-1 text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted transition-colors hover:text-terminal-text"
          >
            Indicators ({activeIndicators.size})
          </button>

          {showIndicatorMenu && (
            <div className="absolute left-0 top-full z-30 mt-1 w-48 rounded-lg border border-terminal-border bg-terminal-bg-secondary py-1 shadow-xl">
              {AVAILABLE_INDICATORS.map((ind) => (
                <button
                  key={ind.id}
                  onClick={() => toggleIndicator(ind.id)}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-terminal-bg-hover',
                    activeIndicators.has(ind.id) ? 'text-terminal-text' : 'text-terminal-text-muted',
                  )}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: ind.color }}
                  />
                  {ind.label}
                  {activeIndicators.has(ind.id) && (
                    <span className="ml-auto text-terminal-accent">&#10003;</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Crosshair OHLCV legend */}
        {crosshairData && (
          <div className="ml-auto flex gap-3 font-mono text-xxs text-terminal-text-secondary">
            <span>
              O <span className="text-terminal-text">{crosshairData.open.toFixed(2)}</span>
            </span>
            <span>
              H <span className="text-terminal-text">{crosshairData.high.toFixed(2)}</span>
            </span>
            <span>
              L <span className="text-terminal-text">{crosshairData.low.toFixed(2)}</span>
            </span>
            <span>
              C <span className="text-terminal-text">{crosshairData.close.toFixed(2)}</span>
            </span>
            <span>
              V{' '}
              <span className="text-terminal-text">
                {crosshairData.volume.toLocaleString()}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Chart canvas */}
      <div ref={containerRef} className="relative w-full" style={{ height }} />

      {/* Indicator overlays */}
      <IndicatorOverlay
        chart={chartRef.current}
        instrumentId={instrumentId}
        barSize={activeTimeframe.barSize}
        start={start}
        indicators={activeIndicatorConfigs}
      />
    </div>
  );
}
