/**
 * WebSocket Service
 *
 * Manages a single WebSocket connection to the real-time data gateway.
 *
 * Features:
 *  - Automatic reconnect with exponential back-off (1 s -> 30 s cap)
 *  - Channel-based subscription management (subscribe / unsubscribe)
 *  - Event-emitter pattern for consumer components
 *  - Heartbeat handling to detect stale connections
 *  - JWT authentication on connect
 */

import type { WSEvent, WSEventType } from '@/types';
import { getAccessToken } from './api';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type Listener<T = unknown> = (event: WSEvent<T>) => void;
type Unsubscribe = () => void;

interface PendingSubscription {
  channel: string;
  refCount: number;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
}

type StateListener = (state: ConnectionState) => void;

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;

/* ------------------------------------------------------------------ */
/*  WebSocket Service Singleton                                       */
/* ------------------------------------------------------------------ */

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private state: ConnectionState = ConnectionState.DISCONNECTED;

  /** channel -> Set<Listener> */
  private listeners = new Map<string, Set<Listener>>();

  /** type -> Set<Listener> — listen by event type regardless of channel */
  private typeListeners = new Map<string, Set<Listener>>();

  /** Channels the server has acknowledged */
  private activeChannels = new Set<string>();

  /** Channels we intend to subscribe (includes pending) */
  private desiredChannels = new Map<string, PendingSubscription>();

  /** State change listeners */
  private stateListeners = new Set<StateListener>();

  /** Reconnect state */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Heartbeat */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Sequence tracking for gap detection */
  private lastSequenceByChannel = new Map<string, number>();

  constructor() {
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = process.env.NEXT_PUBLIC_WS_HOST ?? (typeof window !== 'undefined' ? window.location.host : 'localhost:4001');
    this.url = `${protocol}://${host}/ws/v1/stream`;
  }

  /* ---------------------------------------------------------------- */
  /*  Connection lifecycle                                            */
  /* ---------------------------------------------------------------- */

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setState(ConnectionState.CONNECTING);

    const token = getAccessToken();
    const urlWithAuth = token ? `${this.url}?token=${encodeURIComponent(token)}` : this.url;

    this.ws = new WebSocket(urlWithAuth);

    this.ws.onopen = () => {
      this.setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.resubscribeAll();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.stopHeartbeat();
      this.activeChannels.clear();

      // 4401 = auth rejected — do not reconnect
      if (event.code === 4401) {
        this.setState(ConnectionState.DISCONNECTED);
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose always fires after onerror — reconnect handled there
    };
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.activeChannels.clear();
    this.setState(ConnectionState.DISCONNECTED);
  }

  /* ---------------------------------------------------------------- */
  /*  Subscription management                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Subscribe to a channel (e.g. "ticks.AAPL", "quotes.AAPL", "news.all").
   * Returns an unsubscribe function.  Reference-counted — the server
   * unsubscribe is only sent when the last consumer unsubscribes.
   */
  subscribe<T = unknown>(channel: string, listener: Listener<T>): Unsubscribe {
    // Track listener
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(listener as Listener);

    // Track desired subscription
    const existing = this.desiredChannels.get(channel);
    if (existing) {
      existing.refCount++;
    } else {
      this.desiredChannels.set(channel, { channel, refCount: 1 });
      this.sendSubscribe(channel);
    }

    // Return cleanup
    return () => {
      const set = this.listeners.get(channel);
      if (set) {
        set.delete(listener as Listener);
        if (set.size === 0) this.listeners.delete(channel);
      }

      const sub = this.desiredChannels.get(channel);
      if (sub) {
        sub.refCount--;
        if (sub.refCount <= 0) {
          this.desiredChannels.delete(channel);
          this.sendUnsubscribe(channel);
          this.activeChannels.delete(channel);
        }
      }
    };
  }

  /**
   * Listen to all events of a specific type, regardless of channel.
   */
  onType<T = unknown>(type: WSEventType | string, listener: Listener<T>): Unsubscribe {
    if (!this.typeListeners.has(type)) {
      this.typeListeners.set(type, new Set());
    }
    this.typeListeners.get(type)!.add(listener as Listener);

    return () => {
      const set = this.typeListeners.get(type);
      if (set) {
        set.delete(listener as Listener);
        if (set.size === 0) this.typeListeners.delete(type);
      }
    };
  }

  /* ---------------------------------------------------------------- */
  /*  State observation                                               */
  /* ---------------------------------------------------------------- */

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: StateListener): Unsubscribe {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                       */
  /* ---------------------------------------------------------------- */

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const fn of this.stateListeners) {
      try {
        fn(state);
      } catch {
        // Listener errors should not break the service.
      }
    }
  }

  private handleMessage(event: MessageEvent): void {
    let parsed: WSEvent;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return;
    }

    // Heartbeat acknowledgement
    if (parsed.type === ('heartbeat' as WSEventType)) {
      this.onHeartbeatResponse();
      return;
    }

    // Subscribe acknowledgement
    if (parsed.type === ('subscribe_ack' as WSEventType)) {
      this.activeChannels.add(parsed.channel);
      return;
    }

    // Unsubscribe acknowledgement
    if (parsed.type === ('unsubscribe_ack' as WSEventType)) {
      this.activeChannels.delete(parsed.channel);
      return;
    }

    // Sequence gap detection
    const lastSeq = this.lastSequenceByChannel.get(parsed.channel);
    if (lastSeq !== undefined && parsed.sequenceId > lastSeq + 1) {
      console.warn(
        `[WS] Sequence gap on channel "${parsed.channel}": expected ${lastSeq + 1}, got ${parsed.sequenceId}`,
      );
    }
    this.lastSequenceByChannel.set(parsed.channel, parsed.sequenceId);

    // Dispatch to channel listeners
    const channelListeners = this.listeners.get(parsed.channel);
    if (channelListeners) {
      for (const fn of channelListeners) {
        try {
          fn(parsed);
        } catch (err) {
          console.error('[WS] Listener error:', err);
        }
      }
    }

    // Dispatch to type listeners
    const typeSet = this.typeListeners.get(parsed.type);
    if (typeSet) {
      for (const fn of typeSet) {
        try {
          fn(parsed);
        } catch (err) {
          console.error('[WS] Type listener error:', err);
        }
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private sendSubscribe(channel: string): void {
    this.send({ action: 'subscribe', channel });
  }

  private sendUnsubscribe(channel: string): void {
    this.send({ action: 'unsubscribe', channel });
  }

  /** After reconnect, re-subscribe to all desired channels. */
  private resubscribeAll(): void {
    for (const channel of this.desiredChannels.keys()) {
      this.sendSubscribe(channel);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Reconnect                                                       */
  /* ---------------------------------------------------------------- */

  private scheduleReconnect(): void {
    this.setState(ConnectionState.RECONNECTING);

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Heartbeat                                                       */
  /* ---------------------------------------------------------------- */

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.send({ action: 'heartbeat' });

      this.heartbeatTimeout = setTimeout(() => {
        // Server did not respond — force reconnect
        console.warn('[WS] Heartbeat timeout — forcing reconnect');
        if (this.ws) {
          this.ws.close(4000, 'Heartbeat timeout');
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private onHeartbeatResponse(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton export                                                  */
/* ------------------------------------------------------------------ */

let _instance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService {
  if (!_instance) {
    _instance = new WebSocketService();
  }
  return _instance;
}

export { WebSocketService };
