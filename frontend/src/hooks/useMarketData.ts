'use client';

/**
 * useMarketData
 *
 * Real-time market data hook.  Subscribes to the WebSocket tick/quote channels
 * for a given instrument and merges updates into local state.  Falls back to a
 * REST snapshot on mount so the UI is never blank while waiting for the first
 * tick.
 *
 * Usage:
 *   const { price, change, changePct, volume, bid, ask, direction } = useMarketData('AAPL');
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebSocketService } from '@/services/websocket';
import { getQuoteSummary } from '@/services/api';
import type { Quote, QuoteSummary, Tick, WSEvent } from '@/types';

export type PriceDirection = 'up' | 'down' | 'flat';

export interface MarketDataState {
  instrumentId: string;
  ticker: string;
  name: string;
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  volume: number;
  high: number;
  low: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  direction: PriceDirection;
  updatedAt: string;
  isLoading: boolean;
  error: string | null;
}

const INITIAL_STATE: MarketDataState = {
  instrumentId: '',
  ticker: '',
  name: '',
  price: 0,
  previousClose: 0,
  change: 0,
  changePct: 0,
  volume: 0,
  high: 0,
  low: 0,
  bid: 0,
  bidSize: 0,
  ask: 0,
  askSize: 0,
  direction: 'flat',
  updatedAt: '',
  isLoading: true,
  error: null,
};

export function useMarketData(instrumentId: string | undefined): MarketDataState {
  const [state, setState] = useState<MarketDataState>(INITIAL_STATE);
  const prevPriceRef = useRef<number>(0);

  // ------------------------------------------------------------------
  // REST snapshot on mount
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!instrumentId) return;

    let cancelled = false;

    setState((s) => ({ ...s, instrumentId, isLoading: true, error: null }));

    getQuoteSummary(instrumentId)
      .then((q: QuoteSummary) => {
        if (cancelled) return;
        prevPriceRef.current = q.lastPrice;
        setState({
          instrumentId: q.instrumentId,
          ticker: q.ticker,
          name: q.name,
          price: q.lastPrice,
          previousClose: q.previousClose,
          change: q.change,
          changePct: q.changePct,
          volume: q.volume,
          high: q.high,
          low: q.low,
          bid: 0,
          bidSize: 0,
          ask: 0,
          askSize: 0,
          direction: q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat',
          updatedAt: q.updatedAt,
          isLoading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState((s) => ({ ...s, isLoading: false, error: (err as Error).message }));
      });

    return () => {
      cancelled = true;
    };
  }, [instrumentId]);

  // ------------------------------------------------------------------
  // WebSocket subscriptions
  // ------------------------------------------------------------------
  const handleTick = useCallback((event: WSEvent<Tick>) => {
    const tick = event.data;
    setState((prev) => {
      const direction: PriceDirection =
        tick.price > prevPriceRef.current ? 'up' :
        tick.price < prevPriceRef.current ? 'down' : 'flat';

      prevPriceRef.current = tick.price;

      const change = tick.price - prev.previousClose;
      const changePct = prev.previousClose !== 0 ? (change / prev.previousClose) * 100 : 0;

      return {
        ...prev,
        price: tick.price,
        change,
        changePct,
        volume: prev.volume + tick.size,
        high: Math.max(prev.high, tick.price),
        low: prev.low === 0 ? tick.price : Math.min(prev.low, tick.price),
        direction,
        updatedAt: tick.timestamp,
      };
    });
  }, []);

  const handleQuote = useCallback((event: WSEvent<Quote>) => {
    const q = event.data;
    setState((prev) => ({
      ...prev,
      bid: q.bidPrice,
      bidSize: q.bidSize,
      ask: q.askPrice,
      askSize: q.askSize,
      updatedAt: q.timestamp,
    }));
  }, []);

  useEffect(() => {
    if (!instrumentId) return;

    const ws = getWebSocketService();
    ws.connect(); // idempotent

    const unsubTick = ws.subscribe<Tick>(`ticks.${instrumentId}`, handleTick);
    const unsubQuote = ws.subscribe<Quote>(`quotes.${instrumentId}`, handleQuote);

    return () => {
      unsubTick();
      unsubQuote();
    };
  }, [instrumentId, handleTick, handleQuote]);

  return state;
}

/* ------------------------------------------------------------------ */
/*  Batch hook: subscribe to multiple instruments                     */
/* ------------------------------------------------------------------ */

export function useMarketDataBatch(instrumentIds: string[]): Map<string, MarketDataState> {
  const [stateMap, setStateMap] = useState<Map<string, MarketDataState>>(new Map());
  const prevPrices = useRef<Map<string, number>>(new Map());

  // REST snapshots
  useEffect(() => {
    if (instrumentIds.length === 0) return;

    let cancelled = false;

    for (const id of instrumentIds) {
      getQuoteSummary(id)
        .then((q) => {
          if (cancelled) return;
          prevPrices.current.set(id, q.lastPrice);
          setStateMap((prev) => {
            const next = new Map(prev);
            next.set(id, {
              instrumentId: q.instrumentId,
              ticker: q.ticker,
              name: q.name,
              price: q.lastPrice,
              previousClose: q.previousClose,
              change: q.change,
              changePct: q.changePct,
              volume: q.volume,
              high: q.high,
              low: q.low,
              bid: 0,
              bidSize: 0,
              ask: 0,
              askSize: 0,
              direction: q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat',
              updatedAt: q.updatedAt,
              isLoading: false,
              error: null,
            });
            return next;
          });
        })
        .catch(() => { /* handled per-instrument */ });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentIds.join(',')]);

  // WebSocket subscriptions
  useEffect(() => {
    if (instrumentIds.length === 0) return;

    const ws = getWebSocketService();
    ws.connect();

    const unsubs: (() => void)[] = [];

    for (const id of instrumentIds) {
      const unsubTick = ws.subscribe<Tick>(`ticks.${id}`, (event) => {
        const tick = event.data;
        setStateMap((prev) => {
          const existing = prev.get(id);
          if (!existing) return prev;

          const prevPrice = prevPrices.current.get(id) ?? 0;
          const direction: PriceDirection =
            tick.price > prevPrice ? 'up' :
            tick.price < prevPrice ? 'down' : 'flat';
          prevPrices.current.set(id, tick.price);

          const change = tick.price - existing.previousClose;
          const changePct = existing.previousClose !== 0 ? (change / existing.previousClose) * 100 : 0;

          const next = new Map(prev);
          next.set(id, {
            ...existing,
            price: tick.price,
            change,
            changePct,
            volume: existing.volume + tick.size,
            high: Math.max(existing.high, tick.price),
            low: existing.low === 0 ? tick.price : Math.min(existing.low, tick.price),
            direction,
            updatedAt: tick.timestamp,
          });
          return next;
        });
      });

      unsubs.push(unsubTick);
    }

    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentIds.join(',')]);

  return stateMap;
}
