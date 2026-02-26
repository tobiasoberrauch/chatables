'use client';

/**
 * IndicatorOverlay
 *
 * Fetches technical-indicator data from the analytics API and renders them as
 * line series on the parent chart.  Overlay indicators (SMA, EMA) are drawn
 * directly on the price pane; oscillators (RSI, MACD) are rendered in their
 * own sub-pane via a separate lightweight-charts instance managed here.
 */

import { useEffect, useRef } from 'react';
import {
  type IChartApi,
  type ISeriesApi,
  type Time,
  createChart,
  ColorType,
  LineStyle,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { getIndicator, getMACD } from '@/services/api';
import type { BarSize, IndicatorSeries, MACDPoint } from '@/types';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface IndicatorConfig {
  id: string;
  indicator: string;          // 'sma' | 'ema' | 'rsi' | 'macd'
  label: string;
  params: Record<string, number>;
  color: string;
  overlay: boolean;           // true = draw on price chart, false = separate pane
}

interface IndicatorOverlayProps {
  chart: IChartApi | null;
  instrumentId: string;
  barSize: BarSize;
  start: string;
  indicators: IndicatorConfig[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function toTime(iso: string): Time {
  return Math.floor(new Date(iso).getTime() / 1000) as Time;
}

/* ------------------------------------------------------------------ */
/*  Individual overlay hook                                           */
/* ------------------------------------------------------------------ */

function OverlayLineSeries({
  chart,
  config,
  instrumentId,
  barSize,
  start,
}: {
  chart: IChartApi;
  config: IndicatorConfig;
  instrumentId: string;
  barSize: BarSize;
  start: string;
}) {
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const { data } = useQuery<IndicatorSeries>({
    queryKey: ['indicator', instrumentId, config.indicator, barSize, start, config.params],
    queryFn: () =>
      getIndicator({
        instrumentId,
        indicator: config.indicator,
        barSize,
        start,
        params: config.params,
      }),
    staleTime: 60_000,
    enabled: config.overlay,
  });

  useEffect(() => {
    if (!chart) return;

    const series = chart.addLineSeries({
      color: config.color,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    seriesRef.current = series;

    return () => {
      try {
        chart.removeSeries(series);
      } catch {
        // Chart may already be disposed
      }
      seriesRef.current = null;
    };
  }, [chart, config.color]);

  useEffect(() => {
    if (!data || !seriesRef.current) return;
    const lineData = data.data.map((p) => ({
      time: toTime(p.timestamp),
      value: p.value,
    }));
    seriesRef.current.setData(lineData);
  }, [data]);

  return null;
}

/* ------------------------------------------------------------------ */
/*  RSI Sub-chart                                                     */
/* ------------------------------------------------------------------ */

function RSISubChart({
  config,
  instrumentId,
  barSize,
  start,
}: {
  config: IndicatorConfig;
  instrumentId: string;
  barSize: BarSize;
  start: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { data } = useQuery<IndicatorSeries>({
    queryKey: ['indicator', instrumentId, 'rsi', barSize, start, config.params],
    queryFn: () =>
      getIndicator({
        instrumentId,
        indicator: 'rsi',
        barSize,
        start,
        params: config.params,
      }),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 120,
      layout: {
        background: { type: ColorType.Solid, color: '#111116' },
        textColor: '#6e6e82',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a1a24', style: LineStyle.Dotted },
        horzLines: { color: '#1a1a24', style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: '#2e2e3e',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
    });

    chartRef.current = chart;

    // Overbought / oversold reference lines
    const series = chart.addLineSeries({
      color: config.color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // Draw at 70/30 levels using baseline or priceLine
    series.createPriceLine({ price: 70, color: '#ff174460', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
    series.createPriceLine({ price: 30, color: '#00c85360', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });

    if (data) {
      series.setData(data.data.map((p) => ({ time: toTime(p.timestamp), value: p.value })));
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <div className="border-t border-terminal-border">
      <div className="px-4 py-1.5">
        <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted">
          RSI ({config.params.period})
        </span>
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  MACD Sub-chart                                                    */
/* ------------------------------------------------------------------ */

function MACDSubChart({
  config,
  instrumentId,
  barSize,
  start,
}: {
  config: IndicatorConfig;
  instrumentId: string;
  barSize: BarSize;
  start: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<MACDPoint[]>({
    queryKey: ['indicator', instrumentId, 'macd', barSize, start],
    queryFn: () => getMACD(instrumentId, barSize, start),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 140,
      layout: {
        background: { type: ColorType.Solid, color: '#111116' },
        textColor: '#6e6e82',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a1a24', style: LineStyle.Dotted },
        horzLines: { color: '#1a1a24', style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: '#2e2e3e' },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
    });

    if (data && data.length > 0) {
      // MACD line
      const macdSeries = chart.addLineSeries({
        color: '#448aff',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      macdSeries.setData(data.map((p) => ({ time: toTime(p.timestamp), value: p.macd })));

      // Signal line
      const signalSeries = chart.addLineSeries({
        color: '#ff6d00',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      signalSeries.setData(data.map((p) => ({ time: toTime(p.timestamp), value: p.signal })));

      // Histogram
      const histSeries = chart.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      });
      histSeries.setData(
        data.map((p) => ({
          time: toTime(p.timestamp),
          value: p.histogram,
          color: p.histogram >= 0 ? 'rgba(0, 200, 83, 0.5)' : 'rgba(255, 23, 68, 0.5)',
        })),
      );

      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [data]);

  return (
    <div className="border-t border-terminal-border">
      <div className="px-4 py-1.5">
        <span className="text-xxs font-semibold uppercase tracking-wider text-terminal-text-muted">
          MACD ({config.params.fast}/{config.params.slow}/{config.params.signal})
        </span>
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function IndicatorOverlay({
  chart,
  instrumentId,
  barSize,
  start,
  indicators,
}: IndicatorOverlayProps) {
  const overlayIndicators = indicators.filter((i) => i.overlay);
  const rsiIndicators = indicators.filter((i) => i.indicator === 'rsi');
  const macdIndicators = indicators.filter((i) => i.indicator === 'macd');

  return (
    <>
      {/* Overlay indicators render as invisible React nodes — they only manipulate chart refs */}
      {chart &&
        overlayIndicators.map((config) => (
          <OverlayLineSeries
            key={config.id}
            chart={chart}
            config={config}
            instrumentId={instrumentId}
            barSize={barSize}
            start={start}
          />
        ))}

      {/* RSI sub-charts */}
      {rsiIndicators.map((config) => (
        <RSISubChart
          key={config.id}
          config={config}
          instrumentId={instrumentId}
          barSize={barSize}
          start={start}
        />
      ))}

      {/* MACD sub-charts */}
      {macdIndicators.map((config) => (
        <MACDSubChart
          key={config.id}
          config={config}
          instrumentId={instrumentId}
          barSize={barSize}
          start={start}
        />
      ))}
    </>
  );
}
