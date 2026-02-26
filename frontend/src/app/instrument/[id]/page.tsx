'use client';

/**
 * Instrument Detail Page
 *
 * Shows PriceChart and CompanyProfile for a single instrument.
 * The instrument ID comes from the dynamic [id] route parameter.
 */

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import PriceChart from '@/components/charts/PriceChart';
import CompanyProfile from '@/components/profile/CompanyProfile';
import { getInstrument } from '@/services/api';
import type { Instrument } from '@/types';

export default function InstrumentPage() {
  const params = useParams<{ id: string }>();
  const instrumentId = params.id;

  const { data: instrument } = useQuery<Instrument>({
    queryKey: ['instrument', instrumentId],
    queryFn: () => getInstrument(instrumentId),
    staleTime: 300_000,
    enabled: Boolean(instrumentId),
  });

  if (!instrumentId) {
    return (
      <div className="flex items-center justify-center py-24 text-terminal-text-muted">
        No instrument selected
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Price Chart */}
      <PriceChart
        instrumentId={instrumentId}
        ticker={instrument?.primaryTicker}
        height={480}
      />

      {/* Company Profile */}
      <CompanyProfile instrumentId={instrumentId} />
    </div>
  );
}
