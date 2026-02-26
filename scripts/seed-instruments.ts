/**
 * Seed script to populate the instruments table with well-known equities.
 *
 * Usage: npx ts-node scripts/seed-instruments.ts
 *
 * NOTE: This does NOT generate fake financial data. It seeds the instrument
 * metadata only (names, tickers, identifiers). Price data must come from
 * real data adapters connected to live providers.
 */

import type { Instrument, InstrumentType, AssetClass, TickerAlias } from '../shared/src/types/instrument';

/**
 * Well-known instruments for seeding.
 * ISINs and FIGIs are real identifiers from public registries.
 */
const SEED_INSTRUMENTS: Array<Omit<Instrument, 'createdAt' | 'updatedAt'>> = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    isin: 'US0378331005',
    figi: 'BBG000B9XRY4',
    type: 'EQUITY' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Apple Inc.',
    primaryTicker: 'AAPL',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'AAPL' },
      { source: 'iex', ticker: 'AAPL' },
      { source: 'alphaVantage', ticker: 'AAPL' },
    ] as TickerAlias[],
    country: 'US',
    sector: 'Information Technology',
    industry: 'Technology Hardware, Storage & Peripherals',
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    isin: 'US5949181045',
    figi: 'BBG000BPH459',
    type: 'EQUITY' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Microsoft Corporation',
    primaryTicker: 'MSFT',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'MSFT' },
      { source: 'iex', ticker: 'MSFT' },
      { source: 'alphaVantage', ticker: 'MSFT' },
    ] as TickerAlias[],
    country: 'US',
    sector: 'Information Technology',
    industry: 'Systems Software',
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    isin: 'US0231351067',
    figi: 'BBG000BVPV84',
    type: 'EQUITY' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Amazon.com, Inc.',
    primaryTicker: 'AMZN',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'AMZN' },
      { source: 'iex', ticker: 'AMZN' },
    ] as TickerAlias[],
    country: 'US',
    sector: 'Consumer Discretionary',
    industry: 'Broadline Retail',
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    isin: 'US30303M1027',
    figi: 'BBG009S39JX6',
    type: 'EQUITY' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Meta Platforms, Inc.',
    primaryTicker: 'META',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'META' },
      { source: 'iex', ticker: 'META' },
    ] as TickerAlias[],
    country: 'US',
    sector: 'Communication Services',
    industry: 'Interactive Media & Services',
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    isin: 'US88160R1014',
    figi: 'BBG000N9MNX3',
    type: 'EQUITY' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Tesla, Inc.',
    primaryTicker: 'TSLA',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'TSLA' },
      { source: 'iex', ticker: 'TSLA' },
    ] as TickerAlias[],
    country: 'US',
    sector: 'Consumer Discretionary',
    industry: 'Automobile Manufacturers',
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000010',
    isin: null,
    figi: null,
    type: 'FX' as InstrumentType,
    assetClass: 'FX' as AssetClass,
    name: 'EUR/USD',
    primaryTicker: 'EURUSD',
    primaryExchangeMic: 'XFXS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'C:EURUSD' },
      { source: 'alphaVantage', ticker: 'EURUSD' },
    ] as TickerAlias[],
    country: 'XX',
    sector: null,
    industry: null,
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000011',
    isin: null,
    figi: null,
    type: 'FX' as InstrumentType,
    assetClass: 'FX' as AssetClass,
    name: 'GBP/USD',
    primaryTicker: 'GBPUSD',
    primaryExchangeMic: 'XFXS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'C:GBPUSD' },
      { source: 'alphaVantage', ticker: 'GBPUSD' },
    ] as TickerAlias[],
    country: 'XX',
    sector: null,
    industry: null,
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000012',
    isin: null,
    figi: null,
    type: 'FX' as InstrumentType,
    assetClass: 'FX' as AssetClass,
    name: 'USD/JPY',
    primaryTicker: 'USDJPY',
    primaryExchangeMic: 'XFXS',
    currency: 'JPY',
    tickerAliases: [
      { source: 'polygon', ticker: 'C:USDJPY' },
      { source: 'alphaVantage', ticker: 'USDJPY' },
    ] as TickerAlias[],
    country: 'XX',
    sector: null,
    industry: null,
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000020',
    isin: 'US78378X1072',
    figi: 'BBG000BDTBL9',
    type: 'ETF' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'SPDR S&P 500 ETF Trust',
    primaryTicker: 'SPY',
    primaryExchangeMic: 'ARCX',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'SPY' },
      { source: 'iex', ticker: 'SPY' },
    ] as TickerAlias[],
    country: 'US',
    sector: null,
    industry: null,
    isActive: true,
    delistedAt: null,
  },
  {
    id: '00000000-0000-0000-0000-000000000021',
    isin: 'US46090E1038',
    figi: 'BBG000CGC9C3',
    type: 'ETF' as InstrumentType,
    assetClass: 'EQUITY' as AssetClass,
    name: 'Invesco QQQ Trust',
    primaryTicker: 'QQQ',
    primaryExchangeMic: 'XNAS',
    currency: 'USD',
    tickerAliases: [
      { source: 'polygon', ticker: 'QQQ' },
      { source: 'iex', ticker: 'QQQ' },
    ] as TickerAlias[],
    country: 'US',
    sector: null,
    industry: null,
    isActive: true,
    delistedAt: null,
  },
];

/**
 * Generates INSERT SQL for seeding. Does not execute directly —
 * outputs SQL to stdout for piping into psql or running via migration tool.
 */
function generateSeedSQL(): string {
  const statements: string[] = [];

  for (const inst of SEED_INSTRUMENTS) {
    const isin = inst.isin ? `'${inst.isin}'` : 'NULL';
    const figi = inst.figi ? `'${inst.figi}'` : 'NULL';
    const sector = inst.sector ? `'${inst.sector}'` : 'NULL';
    const industry = inst.industry ? `'${inst.industry}'` : 'NULL';

    statements.push(`
INSERT INTO instruments (id, isin, figi, type, asset_class, name, primary_ticker, primary_exchange_mic, currency, country, sector, industry, is_active, delisted_at)
VALUES ('${inst.id}', ${isin}, ${figi}, '${inst.type}', '${inst.assetClass}', '${inst.name}', '${inst.primaryTicker}', '${inst.primaryExchangeMic}', '${inst.currency}', '${inst.country}', ${sector}, ${industry}, ${inst.isActive}, NULL)
ON CONFLICT (id) DO NOTHING;`);

    for (const alias of inst.tickerAliases) {
      const mic = alias.exchangeMic ? `'${alias.exchangeMic}'` : 'NULL';
      statements.push(`
INSERT INTO ticker_aliases (instrument_id, source, ticker, exchange_mic)
VALUES ('${inst.id}', '${alias.source}', '${alias.ticker}', ${mic})
ON CONFLICT (source, ticker, exchange_mic) DO NOTHING;`);
    }
  }

  return `-- Auto-generated seed data for instruments\nBEGIN;\n${statements.join('\n')}\nCOMMIT;\n`;
}

// When run as a script, output SQL to stdout
console.log(generateSeedSQL());
