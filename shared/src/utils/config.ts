/**
 * Centralized configuration loader with validation.
 * Reads from environment variables. Fails fast on missing required values.
 */

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // Database
  databaseUrl: string;

  // Redis
  redisUrl: string;

  // JWT
  jwtSecret: string;
  jwtExpiry: string;
  refreshTokenExpiry: string;

  // API
  port: number;

  // Data providers
  polygonApiKey: string;
  iexApiKey: string;
  alphaVantageApiKey: string;
  newsApiKey: string;
  fredApiKey: string;

  // LLM
  anthropicApiKey: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const missing: string[] = [];

  function required(key: string): string {
    const val = env[key];
    if (!val) {
      missing.push(key);
      return '';
    }
    return val;
  }

  function optional(key: string, fallback: string): string {
    return env[key] || fallback;
  }

  const config: AppConfig = {
    nodeEnv: optional('NODE_ENV', 'development') as AppConfig['nodeEnv'],
    logLevel: optional('LOG_LEVEL', 'info') as AppConfig['logLevel'],

    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),

    jwtSecret: required('JWT_SECRET'),
    jwtExpiry: optional('JWT_EXPIRY', '15m'),
    refreshTokenExpiry: optional('REFRESH_TOKEN_EXPIRY', '7d'),

    port: parseInt(optional('PORT', '3000'), 10),

    polygonApiKey: optional('POLYGON_API_KEY', ''),
    iexApiKey: optional('IEX_API_KEY', ''),
    alphaVantageApiKey: optional('ALPHA_VANTAGE_API_KEY', ''),
    newsApiKey: optional('NEWS_API_KEY', ''),
    fredApiKey: optional('FRED_API_KEY', ''),

    anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return config;
}
