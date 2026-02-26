/**
 * Redis cache layer for real-time market data.
 *
 * Responsibilities:
 *   - Cache latest ticks and quotes per instrument (TTL: 60s)
 *   - Publish normalized ticks to Redis Streams for downstream consumers
 *   - Store rate-limit state for data adapters
 *   - Provide pub/sub for real-time WebSocket fanout
 */

import { Logger } from '../../../../shared/src/utils/logger';
import type { Tick, Quote, OHLCVBar } from '../../../../shared/src/types/instrument';

const logger = new Logger('redis-cache');

export interface RedisConfig {
  url: string;
}

/**
 * Redis client abstraction.
 * Expects an ioredis-compatible client to be injected.
 */
export class RedisCache {
  private client: RedisClient;
  private subscriber: RedisClient;

  constructor(client: RedisClient, subscriber: RedisClient) {
    this.client = client;
    this.subscriber = subscriber;
  }

  // ─── Tick Cache ───

  /** Cache the latest tick for an instrument. TTL = 60s. */
  async cacheLatestTick(tick: Tick): Promise<void> {
    const key = `tick:${tick.instrumentId}`;
    await this.client.set(key, JSON.stringify(tick), 'EX', 60);
  }

  /** Get the latest cached tick for an instrument. */
  async getLatestTick(instrumentId: string): Promise<Tick | null> {
    const raw = await this.client.get(`tick:${instrumentId}`);
    return raw ? JSON.parse(raw) : null;
  }

  // ─── Quote Cache ───

  async cacheLatestQuote(quote: Quote): Promise<void> {
    const key = `quote:${quote.instrumentId}`;
    await this.client.set(key, JSON.stringify(quote), 'EX', 60);
  }

  async getLatestQuote(instrumentId: string): Promise<Quote | null> {
    const raw = await this.client.get(`quote:${instrumentId}`);
    return raw ? JSON.parse(raw) : null;
  }

  // ─── Real-time Bar Cache ───

  /** Cache latest 1-minute bar. Used for real-time chart updates. */
  async cacheLatestBar(bar: OHLCVBar): Promise<void> {
    const key = `bar:${bar.instrumentId}:${bar.barSize}`;
    await this.client.set(key, JSON.stringify(bar), 'EX', 300);
  }

  // ─── Redis Streams (for event-driven processing) ───

  /**
   * Publish a normalized tick to the 'ticks' stream.
   * Consumer groups downstream: persistence, WebSocket fanout, analytics.
   */
  async publishTick(tick: Tick): Promise<string> {
    const streamId = await this.client.xadd(
      'stream:ticks',
      'MAXLEN', '~', '100000',  // Keep ~100K entries, auto-trim
      '*',                       // Auto-generate ID
      'data', JSON.stringify(tick),
      'instrumentId', tick.instrumentId,
      'timestamp', tick.timestamp,
    );
    logger.debug('Published tick to stream', {
      instrumentId: tick.instrumentId,
      streamId,
    });
    return streamId;
  }

  /** Publish a news event to the 'news' stream. */
  async publishNewsEvent(articleId: string, instrumentIds: string[]): Promise<string> {
    return this.client.xadd(
      'stream:news',
      'MAXLEN', '~', '10000',
      '*',
      'articleId', articleId,
      'instrumentIds', JSON.stringify(instrumentIds),
    );
  }

  /**
   * Create consumer group for a stream if it doesn't exist.
   * Called during service initialization.
   */
  async ensureConsumerGroup(
    stream: string,
    group: string,
  ): Promise<void> {
    try {
      await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
      logger.info('Created consumer group', { stream, group });
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Read messages from a stream as part of a consumer group.
   * Returns unacknowledged messages for this consumer.
   */
  async readFromStream(
    stream: string,
    group: string,
    consumer: string,
    count: number = 10,
    blockMs: number = 5000,
  ): Promise<StreamMessage[]> {
    const result = await this.client.xreadgroup(
      'GROUP', group, consumer,
      'COUNT', count.toString(),
      'BLOCK', blockMs.toString(),
      'STREAMS', stream, '>',
    );

    if (!result) return [];

    const messages: StreamMessage[] = [];
    for (const [, entries] of result) {
      for (const [id, fields] of entries) {
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        messages.push({ id, data });
      }
    }
    return messages;
  }

  /** Acknowledge a processed message. */
  async ack(stream: string, group: string, messageId: string): Promise<void> {
    await this.client.xack(stream, group, messageId);
  }

  // ─── Pub/Sub (for WebSocket fanout across instances) ───

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async subscribe(
    channel: string,
    callback: (message: string) => void,
  ): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch: string, msg: string) => {
      if (ch === channel) callback(msg);
    });
  }

  // ─── Movers Cache ───

  /** Cache top movers (gainers/losers). Recomputed periodically. */
  async cacheMovers(
    movers: { gainers: MoverEntry[]; losers: MoverEntry[] },
  ): Promise<void> {
    await this.client.set('movers:latest', JSON.stringify(movers), 'EX', 30);
  }

  async getMovers(): Promise<{ gainers: MoverEntry[]; losers: MoverEntry[] } | null> {
    const raw = await this.client.get('movers:latest');
    return raw ? JSON.parse(raw) : null;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
  }
}

export interface StreamMessage {
  id: string;
  data: Record<string, string>;
}

export interface MoverEntry {
  instrumentId: string;
  ticker: string;
  price: number;
  changePercent: number;
  volume: number;
}

/**
 * Minimal interface for ioredis client methods we use.
 * Allows easy mocking in tests.
 */
export interface RedisClient {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  xadd(key: string, ...args: (string | number)[]): Promise<string>;
  xreadgroup(...args: (string | number)[]): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xack(key: string, group: string, id: string): Promise<number>;
  xgroup(...args: (string | number)[]): Promise<string>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<number>;
  on(event: string, callback: (...args: string[]) => void): void;
  quit(): Promise<string>;
}
