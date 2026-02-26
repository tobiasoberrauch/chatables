import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { ApiError } from '../../../shared/src/types/instrument';

// Route factories
import { createInstrumentsRouter } from './routes/instruments';
import { createMarketDataRouter } from './routes/market-data';
import { createAnalyticsRouter } from './routes/analytics';
import { createNewsRouter } from './routes/news';
import { createCalendarRouter } from './routes/calendar';
import { createAuthRouter } from './routes/auth';

// WebSocket
import { createWebSocketHandler } from './ws/handler';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

const POSTGRES_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/chatables';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({
  name: 'api-server',
  level: process.env.LOG_LEVEL ?? (NODE_ENV === 'production' ? 'info' : 'debug'),
  ...(NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
  }),
});

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

/**
 * In-process Prometheus metrics tracking.
 *
 * Tracks request count and latency per method/route/status without
 * requiring the prom-client package. For full histogram bucketing in
 * production, swap this for prom-client's defaultMetrics + custom
 * Histogram.
 */

interface MetricsBucket {
  count: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

const httpMetrics = {
  /** Total requests by method + route + status */
  requests: new Map<string, MetricsBucket>(),
  /** Global counters */
  totalRequests: 0,
  totalErrors: 0,
  startTime: Date.now(),
};

function recordRequest(
  method: string,
  route: string,
  statusCode: number,
  latencyMs: number,
): void {
  httpMetrics.totalRequests++;
  if (statusCode >= 500) httpMetrics.totalErrors++;

  const key = `${method}|${route}|${statusCode}`;
  const bucket = httpMetrics.requests.get(key);
  if (bucket) {
    bucket.count++;
    bucket.totalLatencyMs += latencyMs;
    bucket.maxLatencyMs = Math.max(bucket.maxLatencyMs, latencyMs);
  } else {
    httpMetrics.requests.set(key, {
      count: 1,
      totalLatencyMs: latencyMs,
      maxLatencyMs: latencyMs,
    });
  }
}

/**
 * Serialize all metrics in Prometheus text exposition format
 * (compatible with /metrics scraping by Prometheus, Grafana Agent, etc.)
 */
function serializeMetrics(): string {
  const lines: string[] = [];
  const uptimeSeconds = Math.floor((Date.now() - httpMetrics.startTime) / 1000);

  // Uptime gauge
  lines.push('# HELP chatables_api_uptime_seconds Time since server start in seconds');
  lines.push('# TYPE chatables_api_uptime_seconds gauge');
  lines.push(`chatables_api_uptime_seconds ${uptimeSeconds}`);
  lines.push('');

  // Total request counter
  lines.push('# HELP chatables_api_http_requests_total Total HTTP requests');
  lines.push('# TYPE chatables_api_http_requests_total counter');
  lines.push(`chatables_api_http_requests_total ${httpMetrics.totalRequests}`);
  lines.push('');

  // Total error counter
  lines.push('# HELP chatables_api_http_errors_total Total HTTP 5xx errors');
  lines.push('# TYPE chatables_api_http_errors_total counter');
  lines.push(`chatables_api_http_errors_total ${httpMetrics.totalErrors}`);
  lines.push('');

  // Per-route request count
  lines.push('# HELP chatables_api_http_request_count Requests by method, route, status');
  lines.push('# TYPE chatables_api_http_request_count counter');
  for (const [key, bucket] of httpMetrics.requests) {
    const [method, route, status] = key.split('|');
    lines.push(
      `chatables_api_http_request_count{method="${method}",route="${route}",status="${status}"} ${bucket.count}`,
    );
  }
  lines.push('');

  // Per-route average latency
  lines.push(
    '# HELP chatables_api_http_request_duration_avg_ms Average request duration in milliseconds',
  );
  lines.push('# TYPE chatables_api_http_request_duration_avg_ms gauge');
  for (const [key, bucket] of httpMetrics.requests) {
    const [method, route, status] = key.split('|');
    const avg = bucket.count > 0 ? (bucket.totalLatencyMs / bucket.count).toFixed(2) : '0';
    lines.push(
      `chatables_api_http_request_duration_avg_ms{method="${method}",route="${route}",status="${status}"} ${avg}`,
    );
  }
  lines.push('');

  // Per-route max latency
  lines.push(
    '# HELP chatables_api_http_request_duration_max_ms Max request duration in milliseconds',
  );
  lines.push('# TYPE chatables_api_http_request_duration_max_ms gauge');
  for (const [key, bucket] of httpMetrics.requests) {
    const [method, route, status] = key.split('|');
    lines.push(
      `chatables_api_http_request_duration_max_ms{method="${method}",route="${route}",status="${status}"} ${bucket.maxLatencyMs}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Database & Redis connections
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: POSTGRES_URL,
  max: parseInt(process.env.PG_POOL_MAX ?? '20', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  lazyConnect: true,
});

// Dedicated Redis connections for pub/sub (ioredis requires separate instances)
const redisSub = new Redis(REDIS_URL, { lazyConnect: true });
const redisPub = new Redis(REDIS_URL, { lazyConnect: true });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// --- Security headers ---
app.use(
  helmet({
    contentSecurityPolicy: NODE_ENV === 'production' ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }),
);

// --- CORS ---
app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Remaining'],
    maxAge: 86400,
  }),
);

// --- Compression ---
app.use(compression());

// --- Body parsing ---
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// --- Request ID middleware ---
app.use((req: Request, _res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) ?? uuidv4();
  req.requestId = requestId;
  _res.setHeader('X-Request-ID', requestId);
  next();
});

// --- Metrics collection middleware ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = durationNs / 1_000_000;

    // Normalize dynamic route segments to prevent label cardinality explosion
    const route = req.route?.path ?? req.path.replace(/\/[0-9a-f-]{36}/g, '/:id');
    recordRequest(req.method, route, res.statusCode, durationMs);
  });

  next();
});

// --- HTTP request logging ---
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as any).requestId,
    customProps: (req) => ({ requestId: (req as any).requestId }),
    // Don't log health/ready/metrics spam
    autoLogging: {
      ignore: (req) =>
        req.url === '/health' || req.url === '/ready' || req.url === '/metrics',
    },
  }),
);

// ---------------------------------------------------------------------------
// Health, readiness & metrics endpoints
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Check Postgres
    await pool.query('SELECT 1');
    // Check Redis
    await redis.ping();

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: { postgres: 'ok', redis: 'ok' },
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: err.message,
    });
  }
});

app.get('/metrics', (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(serializeMetrics());
});

// ---------------------------------------------------------------------------
// Mount route modules under /api/v1
// ---------------------------------------------------------------------------

app.use('/api/v1/instruments', createInstrumentsRouter(pool));
app.use('/api/v1/market-data', createMarketDataRouter(pool, redis));
app.use('/api/v1/analytics', createAnalyticsRouter(pool, redis));
app.use('/api/v1/news', createNewsRouter(pool));
app.use('/api/v1/calendar', createCalendarRouter(pool));
app.use('/api/v1/auth', createAuthRouter(pool, redis));

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((req: Request, res: Response) => {
  const error: ApiError = {
    code: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`,
    requestId: req.requestId ?? 'unknown',
    timestamp: new Date().toISOString(),
  };
  res.status(404).json(error);
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.requestId ?? 'unknown';

  // Log the full error server-side
  logger.error(
    { err, requestId, method: req.method, url: req.url },
    'Unhandled error in request handler',
  );

  // Don't leak internal error details in production
  const message =
    NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message ?? 'Internal server error';

  const status = typeof err.status === 'number' ? err.status : 500;

  const error: ApiError = {
    code: 'INTERNAL_ERROR',
    message,
    requestId,
    timestamp: new Date().toISOString(),
    ...(NODE_ENV !== 'production' && { details: { stack: err.stack } }),
  };

  res.status(status).json(error);
});

// ---------------------------------------------------------------------------
// HTTP server + WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    // Connect to external services
    logger.info('Connecting to PostgreSQL...');
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    logger.info('Connecting to Redis...');
    await redis.connect();
    await redisSub.connect();
    await redisPub.connect();
    logger.info('Redis connected');

    // Start WebSocket handler on the same HTTP server
    const { shutdown: shutdownWs } = createWebSocketHandler(server, redisSub, redisPub);

    // Start listening
    server.listen(PORT, HOST, () => {
      logger.info({ port: PORT, host: HOST, env: NODE_ENV }, 'API server started');
    });

    // ------------------------------------------------------------------
    // Graceful shutdown
    // ------------------------------------------------------------------

    let isShuttingDown = false;

    async function gracefulShutdown(signal: string): Promise<void> {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

      // 1. Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // 2. Shut down WebSocket
      await shutdownWs();

      // 3. Close Redis connections
      redis.disconnect();
      redisSub.disconnect();
      redisPub.disconnect();
      logger.info('Redis connections closed');

      // 4. Drain PostgreSQL pool
      await pool.end();
      logger.info('PostgreSQL pool drained');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Catch unhandled rejections / exceptions so the process doesn't silently die
    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ reason, promise }, 'Unhandled promise rejection');
    });

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception — shutting down');
      gracefulShutdown('uncaughtException');
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { app, server };
