# Financial Market Terminal — System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js)                          │
│  Real-time Dashboards │ Charts │ News │ Calendar │ Profiles        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS / WSS
┌──────────────────────────────▼──────────────────────────────────────┐
│                         API GATEWAY                                 │
│  REST (versioned) │ WebSocket │ JWT+RBAC Auth │ Rate Limiting       │
└───────┬───────────────────┬───────────────────┬─────────────────────┘
        │                   │                   │
┌───────▼───────┐  ┌────────▼────────┐  ┌──────▼──────────┐
│  ANALYTICS    │  │   QUERY ENGINE  │  │  STREAMING      │
│  ENGINE       │  │                 │  │  ENGINE          │
│ - Indicators  │  │ - Instruments   │  │ - Tick fanout    │
│ - Sentiment   │  │ - Time series   │  │ - Event pubsub  │
│ - Correlation │  │ - Fundamentals  │  │ - Redis Streams  │
│ - Portfolio   │  │ - News search   │  │                  │
└───────┬───────┘  └────────┬────────┘  └──────┬──────────┘
        │                   │                   │
┌───────▼───────────────────▼───────────────────▼─────────────────────┐
│                       STORAGE LAYER                                  │
│  PostgreSQL (entities) │ TimescaleDB (OHLCV) │ Redis (cache/stream) │
└───────────────────────────────▲──────────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────────┐
│                    DATA INGESTION PIPELINE                            │
│  Adapters → Normalization → Validation → Storage                     │
│                                                                      │
│  Polygon │ IEX │ AlphaVantage │ NewsAPI │ FRED │ SEC EDGAR           │
└──────────────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Canonical Schema First** — All external data normalizes into internal schema before storage
2. **Separation of Concerns** — Ingestion, storage, analytics, API, and frontend are independent services
3. **Real-time + Historical** — Dual-path: streaming for live ticks, batch for historical backfill
4. **Idempotent Writes** — All ingestion is idempotent via composite unique keys
5. **Horizontal Scaling** — Stateless services behind load balancers; TimescaleDB handles time-series partitioning

## Scaling Strategy

- **Data Ingestion**: Scale horizontally by adapter. Each adapter runs independently.
- **API Layer**: Stateless Node.js processes behind a load balancer. WebSocket connections managed via Redis pub/sub for cross-instance fanout.
- **TimescaleDB**: Hypertables auto-partition by time. Add read replicas for query scaling.
- **Redis**: Cluster mode for streaming. Separate instances for cache vs. streams.
- **Analytics**: CPU-bound work offloaded to worker processes. Heavy computations (correlation matrices) run async with results cached.

## Failure Handling

- All external API calls: exponential backoff with jitter (base 1s, max 60s, max 5 retries)
- Circuit breaker per data source (trips after 5 consecutive failures, half-open after 30s)
- Dead letter queue for failed ingestion records
- Health checks on all services (liveness + readiness probes)
- Structured logging (JSON) to stdout, collected by Fluentd → Elasticsearch

## Observability

- **Metrics**: Prometheus exporters on every service
- **Dashboards**: Grafana dashboards for ingestion rates, API latency, error rates, WebSocket connections
- **Alerts**: PagerDuty integration for SLA breaches
- **Tracing**: OpenTelemetry spans across service boundaries
- **Audit Log**: All API mutations logged with user, timestamp, payload hash

## Real-Time Streaming Architecture

```
External Feed → Adapter → Redis Stream (raw ticks)
                              │
                    ┌─────────▼──────────┐
                    │  Normalizer Worker  │
                    └─────────┬──────────┘
                              │
                    Redis Stream (normalized ticks)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        TimescaleDB      WebSocket         Analytics
        (persist)        (fanout)          (real-time)
```

- Raw ticks arrive via WebSocket/polling from providers
- Published to Redis Streams (consumer groups for guaranteed processing)
- Normalizer workers consume, validate, and re-publish
- Multiple consumers: persistence, WebSocket fanout, real-time analytics
- WebSocket fanout uses Redis pub/sub for multi-instance delivery
