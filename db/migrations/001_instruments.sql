-- Migration 001: Core instrument and market data tables
-- PostgreSQL 15+ with TimescaleDB extension

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

---------------------------------------------------------------------------
-- INSTRUMENTS
---------------------------------------------------------------------------
CREATE TYPE instrument_type AS ENUM (
    'EQUITY', 'ETF', 'FX', 'INDEX', 'BOND', 'OPTION', 'FUTURE', 'CRYPTO'
);

CREATE TYPE asset_class AS ENUM (
    'EQUITY', 'FIXED_INCOME', 'FX', 'COMMODITY', 'CRYPTO'
);

CREATE TABLE instruments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    isin            VARCHAR(12),
    figi            VARCHAR(12),
    type            instrument_type NOT NULL,
    asset_class     asset_class NOT NULL,
    name            TEXT NOT NULL,
    primary_ticker  VARCHAR(32) NOT NULL,
    primary_exchange_mic VARCHAR(10) NOT NULL,
    currency        VARCHAR(3) NOT NULL,
    country         VARCHAR(2) NOT NULL,
    sector          TEXT,
    industry        TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    delisted_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: ISIN must be unique when present
CREATE UNIQUE INDEX idx_instruments_isin ON instruments (isin) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX idx_instruments_figi ON instruments (figi) WHERE figi IS NOT NULL;
CREATE INDEX idx_instruments_ticker ON instruments (primary_ticker);
CREATE INDEX idx_instruments_type ON instruments (type);
CREATE INDEX idx_instruments_active ON instruments (is_active) WHERE is_active = true;

---------------------------------------------------------------------------
-- TICKER ALIASES (many-to-one with instruments)
---------------------------------------------------------------------------
CREATE TABLE ticker_aliases (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id   UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    source          VARCHAR(50) NOT NULL,
    ticker          VARCHAR(50) NOT NULL,
    exchange_mic    VARCHAR(10),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, ticker, exchange_mic)
);

CREATE INDEX idx_ticker_aliases_instrument ON ticker_aliases (instrument_id);
CREATE INDEX idx_ticker_aliases_lookup ON ticker_aliases (source, ticker);

---------------------------------------------------------------------------
-- CORPORATE ACTIONS
---------------------------------------------------------------------------
CREATE TYPE corporate_action_type AS ENUM (
    'SPLIT', 'REVERSE_SPLIT', 'DIVIDEND', 'SPECIAL_DIVIDEND',
    'SPINOFF', 'MERGER', 'RIGHTS_ISSUE', 'NAME_CHANGE', 'TICKER_CHANGE'
);

CREATE TABLE corporate_actions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id   UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    type            corporate_action_type NOT NULL,
    ex_date         DATE NOT NULL,
    record_date     DATE,
    payment_date    DATE,
    ratio           NUMERIC(18, 8),
    amount          NUMERIC(18, 8),
    currency        VARCHAR(3),
    description     TEXT NOT NULL,
    source          VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (instrument_id, type, ex_date, source)
);

CREATE INDEX idx_corporate_actions_instrument ON corporate_actions (instrument_id, ex_date DESC);

---------------------------------------------------------------------------
-- OHLCV BARS (TimescaleDB hypertable)
---------------------------------------------------------------------------
CREATE TYPE bar_size AS ENUM (
    'tick', '1s', '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'
);

CREATE TABLE ohlcv_bars (
    instrument_id   UUID NOT NULL REFERENCES instruments(id),
    timestamp       TIMESTAMPTZ NOT NULL,
    open            NUMERIC(18, 8) NOT NULL,
    high            NUMERIC(18, 8) NOT NULL,
    low             NUMERIC(18, 8) NOT NULL,
    close           NUMERIC(18, 8) NOT NULL,
    volume          NUMERIC(24, 4) NOT NULL DEFAULT 0,
    vwap            NUMERIC(18, 8),
    trades          INTEGER,
    bar_size        bar_size NOT NULL DEFAULT '1d',
    is_adjusted     BOOLEAN NOT NULL DEFAULT false,
    source          VARCHAR(50) NOT NULL,
    UNIQUE (instrument_id, timestamp, bar_size, is_adjusted)
);

-- Convert to TimescaleDB hypertable, partitioned by time
SELECT create_hypertable('ohlcv_bars', 'timestamp',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE
);

-- Compound index for typical query: get bars for an instrument in a time range
CREATE INDEX idx_ohlcv_instrument_time ON ohlcv_bars (instrument_id, timestamp DESC);
-- Index for bar size filtering
CREATE INDEX idx_ohlcv_bar_size ON ohlcv_bars (bar_size, timestamp DESC);

-- Enable compression on older chunks (older than 7 days)
ALTER TABLE ohlcv_bars SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id, bar_size, is_adjusted',
    timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy('ohlcv_bars', INTERVAL '7 days');

---------------------------------------------------------------------------
-- COMPANY FUNDAMENTALS
---------------------------------------------------------------------------
CREATE TABLE company_fundamentals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id   UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    report_date     DATE NOT NULL,
    period          VARCHAR(4) NOT NULL,       -- Q1, Q2, Q3, Q4, FY
    fiscal_year     INTEGER NOT NULL,
    revenue         NUMERIC(20, 2),
    net_income      NUMERIC(20, 2),
    eps             NUMERIC(12, 4),
    eps_estimate    NUMERIC(12, 4),
    market_cap      NUMERIC(20, 2),
    pe_ratio        NUMERIC(12, 4),
    pb_ratio        NUMERIC(12, 4),
    debt_to_equity  NUMERIC(12, 4),
    dividend_yield  NUMERIC(8, 4),
    free_cash_flow  NUMERIC(20, 2),
    currency        VARCHAR(3) NOT NULL,
    source          VARCHAR(50) NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (instrument_id, report_date, period, source)
);

CREATE INDEX idx_fundamentals_instrument ON company_fundamentals (instrument_id, report_date DESC);

---------------------------------------------------------------------------
-- EARNINGS EVENTS
---------------------------------------------------------------------------
CREATE TABLE earnings_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id   UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    report_date     DATE NOT NULL,
    fiscal_quarter  VARCHAR(16) NOT NULL,
    eps_actual      NUMERIC(12, 4),
    eps_estimate    NUMERIC(12, 4),
    revenue_actual  NUMERIC(20, 2),
    revenue_estimate NUMERIC(20, 2),
    surprise        NUMERIC(10, 4),
    transcript_url  TEXT,
    source          VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (instrument_id, report_date, source)
);

CREATE INDEX idx_earnings_instrument ON earnings_events (instrument_id, report_date DESC);
CREATE INDEX idx_earnings_date ON earnings_events (report_date DESC);

---------------------------------------------------------------------------
-- MACRO EVENTS
---------------------------------------------------------------------------
CREATE TYPE macro_category AS ENUM (
    'EMPLOYMENT', 'INFLATION', 'GDP', 'CENTRAL_BANK',
    'HOUSING', 'MANUFACTURING', 'CONSUMER', 'TRADE'
);

CREATE TABLE macro_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    country         VARCHAR(2) NOT NULL,
    category        macro_category NOT NULL,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    actual          NUMERIC(18, 4),
    forecast        NUMERIC(18, 4),
    previous        NUMERIC(18, 4),
    unit            VARCHAR(20) NOT NULL,
    impact          VARCHAR(10) NOT NULL CHECK (impact IN ('high', 'medium', 'low')),
    source          VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, scheduled_at, source)
);

CREATE INDEX idx_macro_events_date ON macro_events (scheduled_at DESC);
CREATE INDEX idx_macro_events_country ON macro_events (country, scheduled_at DESC);
CREATE INDEX idx_macro_events_category ON macro_events (category, scheduled_at DESC);

---------------------------------------------------------------------------
-- NEWS ARTICLES
---------------------------------------------------------------------------
CREATE TABLE news_articles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    content         TEXT,
    url             TEXT NOT NULL UNIQUE,
    source          VARCHAR(100) NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL,
    sentiment_score NUMERIC(4, 3) CHECK (sentiment_score >= -1 AND sentiment_score <= 1),
    sentiment_label VARCHAR(10) CHECK (sentiment_label IN ('bearish', 'neutral', 'bullish')),
    categories      TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_news_published ON news_articles (published_at DESC);
CREATE INDEX idx_news_sentiment ON news_articles (sentiment_label, published_at DESC);
CREATE INDEX idx_news_source ON news_articles (source, published_at DESC);

-- Many-to-many: news ↔ instruments
CREATE TABLE news_instruments (
    news_id         UUID NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    instrument_id   UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    PRIMARY KEY (news_id, instrument_id)
);

CREATE INDEX idx_news_instruments_instrument ON news_instruments (instrument_id);

---------------------------------------------------------------------------
-- USERS & AUTH
---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('viewer', 'analyst', 'admin');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role NOT NULL DEFAULT 'viewer',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);

---------------------------------------------------------------------------
-- AUDIT LOG
---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(50) NOT NULL,
    resource_type   VARCHAR(50) NOT NULL,
    resource_id     TEXT,
    payload_hash    VARCHAR(64),
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_log_resource ON audit_log (resource_type, resource_id);

-- Convert to hypertable for automatic time partitioning
SELECT create_hypertable('audit_log', 'created_at',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE,
    migrate_data => TRUE
);

---------------------------------------------------------------------------
-- UPDATED_AT TRIGGER
---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_instruments_updated_at BEFORE UPDATE ON instruments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
