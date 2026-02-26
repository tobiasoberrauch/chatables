import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { Server as HttpServer } from 'http';
import Redis from 'ioredis';
import { URL } from 'url';
import { verifyAccessToken } from '../middleware/auth';
import {
  WSEventType,
  type WSEvent,
  type JWTPayload,
} from '../../../../shared/src/types/instrument';
import pino from 'pino';

const logger = pino({ name: 'ws-handler' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid channel patterns clients can subscribe to */
const CHANNEL_PATTERNS = [
  /^ticks\.\w+$/,           // ticks.AAPL
  /^quotes\.\w+$/,          // quotes.AAPL
  /^news\.all$/,            // news.all
  /^news\.[0-9a-f-]+$/,    // news.{instrumentId}
  /^calendar\.macro$/,      // calendar.macro
];

interface AuthenticatedSocket {
  ws: WebSocket;
  user: JWTPayload;
  subscriptions: Set<string>;
  isAlive: boolean;
  connectedAt: number;
}

interface ClientMessage {
  action: 'subscribe' | 'unsubscribe' | 'auth' | 'ping';
  channels?: string[];
  token?: string;
}

// ---------------------------------------------------------------------------
// Sequence counter — monotonically increasing per process
// ---------------------------------------------------------------------------

let sequenceCounter = 0;
function nextSequenceId(): number {
  return ++sequenceCounter;
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

export function createWebSocketHandler(
  server: HttpServer,
  redisSub: Redis,
  redisPub: Redis,
): {
  wss: WebSocketServer;
  shutdown: () => Promise<void>;
} {
  const wss = new WebSocketServer({ server, path: '/ws' });

  /**
   * Map of WebSocket -> authenticated state.
   * Sockets that have not authenticated within AUTH_TIMEOUT_MS are terminated.
   */
  const clients = new Map<WebSocket, AuthenticatedSocket>();

  const AUTH_TIMEOUT_MS = 10_000;
  const HEARTBEAT_INTERVAL_MS = 30_000;

  // -----------------------------------------------------------------------
  // Channel validation
  // -----------------------------------------------------------------------

  function isValidChannel(channel: string): boolean {
    return CHANNEL_PATTERNS.some((pattern) => pattern.test(channel));
  }

  // -----------------------------------------------------------------------
  // Send helpers
  // -----------------------------------------------------------------------

  function sendEvent<T>(ws: WebSocket, event: WSEvent<T>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  function sendError(ws: WebSocket, message: string, channel = 'system'): void {
    sendEvent(ws, {
      type: WSEventType.ERROR,
      channel,
      timestamp: new Date().toISOString(),
      sequenceId: nextSequenceId(),
      data: { message },
    });
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  function authenticateToken(token: string): JWTPayload | null {
    try {
      return verifyAccessToken(token);
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Connection handler
  // -----------------------------------------------------------------------

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Try to authenticate from query parameter immediately
    let user: JWTPayload | null = null;

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (token) {
        user = authenticateToken(token);
      }
    } catch {
      // URL parsing failure — client must send auth in first message
    }

    if (user) {
      // Authenticated via query param
      const client: AuthenticatedSocket = {
        ws,
        user,
        subscriptions: new Set(),
        isAlive: true,
        connectedAt: Date.now(),
      };
      clients.set(ws, client);
      logger.info({ userId: user.sub }, 'WebSocket client authenticated via query param');
    } else {
      // Give client AUTH_TIMEOUT_MS to send an auth message
      const authTimer = setTimeout(() => {
        if (!clients.has(ws)) {
          sendError(ws, 'Authentication timeout — send { action: "auth", token: "..." } within 10 seconds');
          ws.close(4001, 'Authentication timeout');
        }
      }, AUTH_TIMEOUT_MS);

      // Temporarily store the timer so we can clear it
      (ws as any).__authTimer = authTimer;
    }

    // ----- Message handling -----

    ws.on('message', (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'Invalid JSON');
        return;
      }

      // Handle auth message (before client is in `clients` map)
      if (msg.action === 'auth') {
        if (clients.has(ws)) {
          sendError(ws, 'Already authenticated');
          return;
        }

        if (!msg.token) {
          sendError(ws, 'Token is required for authentication');
          return;
        }

        const authedUser = authenticateToken(msg.token);
        if (!authedUser) {
          sendError(ws, 'Invalid or expired token');
          ws.close(4003, 'Authentication failed');
          return;
        }

        const client: AuthenticatedSocket = {
          ws,
          user: authedUser,
          subscriptions: new Set(),
          isAlive: true,
          connectedAt: Date.now(),
        };
        clients.set(ws, client);

        // Clear the auth timeout
        const timer = (ws as any).__authTimer;
        if (timer) {
          clearTimeout(timer);
          delete (ws as any).__authTimer;
        }

        sendEvent(ws, {
          type: WSEventType.SUBSCRIBE_ACK,
          channel: 'system',
          timestamp: new Date().toISOString(),
          sequenceId: nextSequenceId(),
          data: { message: 'Authenticated successfully', userId: authedUser.sub },
        });

        logger.info({ userId: authedUser.sub }, 'WebSocket client authenticated via message');
        return;
      }

      // All other actions require authentication
      const client = clients.get(ws);
      if (!client) {
        sendError(ws, 'Not authenticated. Send { action: "auth", token: "..." } first.');
        return;
      }

      client.isAlive = true;

      switch (msg.action) {
        case 'ping':
          sendEvent(ws, {
            type: WSEventType.HEARTBEAT,
            channel: 'system',
            timestamp: new Date().toISOString(),
            sequenceId: nextSequenceId(),
            data: { pong: true },
          });
          break;

        case 'subscribe': {
          if (!msg.channels || !Array.isArray(msg.channels)) {
            sendError(ws, 'channels array is required for subscribe action');
            return;
          }

          const subscribed: string[] = [];
          const invalid: string[] = [];

          for (const channel of msg.channels) {
            if (!isValidChannel(channel)) {
              invalid.push(channel);
              continue;
            }
            client.subscriptions.add(channel);
            subscribed.push(channel);

            // Subscribe to Redis channel for cross-instance fanout
            redisSub.subscribe(channel).catch((err) => {
              logger.error({ err, channel }, 'Failed to subscribe to Redis channel');
            });
          }

          sendEvent(ws, {
            type: WSEventType.SUBSCRIBE_ACK,
            channel: 'system',
            timestamp: new Date().toISOString(),
            sequenceId: nextSequenceId(),
            data: {
              subscribed,
              ...(invalid.length > 0 && { invalid }),
            },
          });

          logger.debug(
            { userId: client.user.sub, subscribed, invalid },
            'Client subscribed to channels',
          );
          break;
        }

        case 'unsubscribe': {
          if (!msg.channels || !Array.isArray(msg.channels)) {
            sendError(ws, 'channels array is required for unsubscribe action');
            return;
          }

          const unsubscribed: string[] = [];

          for (const channel of msg.channels) {
            if (client.subscriptions.has(channel)) {
              client.subscriptions.delete(channel);
              unsubscribed.push(channel);

              // Check if any other client is still subscribed to this channel.
              // If not, unsubscribe from Redis.
              let otherSubscribed = false;
              for (const [, otherClient] of clients) {
                if (otherClient !== client && otherClient.subscriptions.has(channel)) {
                  otherSubscribed = true;
                  break;
                }
              }
              if (!otherSubscribed) {
                redisSub.unsubscribe(channel).catch((err) => {
                  logger.error({ err, channel }, 'Failed to unsubscribe from Redis channel');
                });
              }
            }
          }

          sendEvent(ws, {
            type: WSEventType.UNSUBSCRIBE_ACK,
            channel: 'system',
            timestamp: new Date().toISOString(),
            sequenceId: nextSequenceId(),
            data: { unsubscribed },
          });

          logger.debug(
            { userId: client.user.sub, unsubscribed },
            'Client unsubscribed from channels',
          );
          break;
        }

        default:
          sendError(ws, `Unknown action: ${(msg as any).action}`);
      }
    });

    // ----- Close / error handling -----

    ws.on('close', () => {
      const client = clients.get(ws);
      if (client) {
        logger.info(
          { userId: client.user.sub, subscriptions: [...client.subscriptions] },
          'WebSocket client disconnected',
        );

        // Clean up Redis subscriptions if no other clients need them
        for (const channel of client.subscriptions) {
          let otherSubscribed = false;
          for (const [otherWs, otherClient] of clients) {
            if (otherWs !== ws && otherClient.subscriptions.has(channel)) {
              otherSubscribed = true;
              break;
            }
          }
          if (!otherSubscribed) {
            redisSub.unsubscribe(channel).catch(() => {});
          }
        }

        clients.delete(ws);
      } else {
        // Clear auth timer if the socket closes before authenticating
        const timer = (ws as any).__authTimer;
        if (timer) clearTimeout(timer);
      }
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      ws.close();
    });
  });

  // -----------------------------------------------------------------------
  // Redis subscription message handler — fanout to local WebSocket clients
  // -----------------------------------------------------------------------

  redisSub.on('message', (channel: string, message: string) => {
    let event: WSEvent;
    try {
      event = JSON.parse(message);
    } catch {
      logger.warn({ channel, message }, 'Invalid JSON from Redis pub/sub');
      return;
    }

    // Stamp with a local sequence ID for ordering guarantees per-client
    event.sequenceId = nextSequenceId();

    for (const [, client] of clients) {
      if (client.subscriptions.has(channel)) {
        sendEvent(client.ws, event);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Heartbeat interval — detect broken connections
  // -----------------------------------------------------------------------

  const heartbeatInterval = setInterval(() => {
    const now = new Date().toISOString();

    for (const [ws, client] of clients) {
      if (!client.isAlive) {
        logger.info({ userId: client.user.sub }, 'Terminating unresponsive WebSocket client');
        ws.terminate();
        clients.delete(ws);
        continue;
      }

      client.isAlive = false;

      // Send heartbeat
      sendEvent(ws, {
        type: WSEventType.HEARTBEAT,
        channel: 'system',
        timestamp: now,
        sequenceId: nextSequenceId(),
        data: { serverTime: now },
      });

      // Also rely on WebSocket protocol-level ping
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Listen for pong frames to mark connections as alive
  wss.on('connection', (ws: WebSocket) => {
    ws.on('pong', () => {
      const client = clients.get(ws);
      if (client) {
        client.isAlive = true;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Helper: publish an event from the server side (used by REST endpoints
  // or background workers to push data into the WS fanout)
  // -----------------------------------------------------------------------

  /**
   * Publish a WSEvent to a channel via Redis so all server instances
   * deliver it to subscribed WebSocket clients.
   */
  async function publish<T>(channel: string, type: WSEventType, data: T): Promise<void> {
    const event: WSEvent<T> = {
      type,
      channel,
      timestamp: new Date().toISOString(),
      sequenceId: 0, // Will be set per-client on receipt
      data,
    };
    await redisPub.publish(channel, JSON.stringify(event));
  }

  // Expose publish as a property on the WSS for the server module to use
  (wss as any).publish = publish;

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------

  async function shutdown(): Promise<void> {
    logger.info('Shutting down WebSocket server...');

    clearInterval(heartbeatInterval);

    // Close all client connections
    for (const [ws, client] of clients) {
      sendEvent(ws, {
        type: WSEventType.ERROR,
        channel: 'system',
        timestamp: new Date().toISOString(),
        sequenceId: nextSequenceId(),
        data: { message: 'Server is shutting down' },
      });
      ws.close(1001, 'Server shutdown');
    }
    clients.clear();

    // Close the WebSocket server
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info('WebSocket server shut down');
  }

  return { wss, shutdown };
}
