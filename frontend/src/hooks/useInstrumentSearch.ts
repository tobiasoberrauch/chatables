'use client';

/**
 * useInstrumentSearch
 *
 * Debounced instrument search with react-query caching.
 * Returns search results as the user types, with a 250ms debounce.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchInstruments } from '@/services/api';
import type { InstrumentSearchResult } from '@/types';

const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 1;

interface UseInstrumentSearchResult {
  results: InstrumentSearchResult[];
  isLoading: boolean;
  error: string | null;
  query: string;
  setQuery: (q: string) => void;
  clear: () => void;
}

export function useInstrumentSearch(limit = 15): UseInstrumentSearchResult {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce the search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const enabled = debouncedQuery.length >= MIN_QUERY_LENGTH;

  const { data, isLoading, error } = useQuery<InstrumentSearchResult[], Error>({
    queryKey: ['instrument-search', debouncedQuery, limit],
    queryFn: () => searchInstruments(debouncedQuery, limit),
    enabled,
    staleTime: 30_000,          // Cache results for 30s
    gcTime: 5 * 60_000,         // Keep in garbage-collectable cache for 5m
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const clear = () => {
    setQuery('');
    setDebouncedQuery('');
  };

  return {
    results: enabled ? (data ?? []) : [],
    isLoading: enabled && isLoading,
    error: error?.message ?? null,
    query,
    setQuery,
    clear,
  };
}
