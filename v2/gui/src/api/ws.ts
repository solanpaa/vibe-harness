// ---------------------------------------------------------------------------
// WebSocket Manager (CDD-gui §5)
//
// Single WebSocket connection per window. Manages subscription, reconnection,
// and event dispatch to Zustand stores.
// ---------------------------------------------------------------------------

import type { ClientMessage, ServerMessage } from '@vibe-harness/shared';

// ── Config ──

export interface WebSocketConfig {
  getUrl: () => string;
  getAuthToken: () => string;
  /** Initial reconnect delay in ms. Default 1000. */
  initialReconnectDelay?: number;
  /** Maximum reconnect delay in ms. Default 30000. */
  maxReconnectDelay?: number;
  /** Max reconnect attempts before giving up. Default 10. */
  maxReconnectAttempts?: number;
}

// ── State ──

export type WebSocketState = 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting' | 'failed';

type MessageListener = (msg: ServerMessage) => void;
type StateListener = (state: WebSocketState) => void;

// ── Manager ──

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private _state: WebSocketState = 'closed';
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, number>(); // runId → lastSeq
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<(error: Error) => void>();

  constructor(private config: WebSocketConfig) {}

  get state(): WebSocketState {
    return this._state;
  }

  // ── Connection lifecycle ──

  /** Open connection. Auth via query param (CDD-api §13.3). */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this._state === 'connecting') return;

    this.shouldReconnect = true;
    this.setState('connecting');

    const url = `${this.config.getUrl()}?token=${encodeURIComponent(this.config.getAuthToken())}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.setState('open');
      this.reconnectAttempts = 0;
      this.resubscribeAll();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.dispatch(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.shouldReconnect) {
        this.setState('reconnecting');
        this.attemptReconnect();
      } else {
        this.setState('closed');
      }
    };

    this.ws.onerror = () => {
      // onclose fires after onerror — handled there
    };
  }

  /** Close connection permanently (app shutdown). */
  disconnect(): void {
    this.shouldReconnect = false;
    this.setState('closing');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  /** Reconnect to a new URL (e.g. daemon port changed). */
  reconnectToNewUrl(getUrl: () => string, getAuthToken: () => string): void {
    this.config.getUrl = getUrl;
    this.config.getAuthToken = getAuthToken;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.disconnect();
    this.connect();
  }

  // ── Subscriptions ──

  /** Subscribe to a run's streaming output (CDD-api §12.2). */
  subscribe(runId: string, lastSeq?: number): void {
    this.subscriptions.set(runId, lastSeq ?? 0);
    this.send({ type: 'subscribe', runId, lastSeq });
  }

  /** Unsubscribe from a run's stream. */
  unsubscribe(runId: string): void {
    this.subscriptions.delete(runId);
    this.send({ type: 'unsubscribe', runId });
  }

  // ── Event listeners ──

  /** Register listener for all incoming server messages. Returns unsubscribe fn. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Register listener for connection state changes. Returns unsubscribe fn. */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Register listener for errors (e.g. max reconnect attempts exceeded). Returns unsubscribe fn. */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // ── Internal ──

  private setState(state: WebSocketState): void {
    this._state = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* ignore */ }
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private dispatch(msg: ServerMessage): void {
    // Track last sequence number for reconnect replay
    if (msg.type === 'run_output') {
      this.subscriptions.set(msg.runId, msg.seq);
    }

    for (const listener of this.messageListeners) {
      try { listener(msg); } catch { /* ignore listener errors */ }
    }
  }

  /** Resubscribe all tracked runs after reconnect with last-seen seq. */
  private resubscribeAll(): void {
    for (const [runId, lastSeq] of this.subscriptions) {
      this.send({ type: 'subscribe', runId, lastSeq });
    }
  }

  /** Exponential backoff reconnect (CDD-api §12.5). */
  private attemptReconnect(): void {
    const max = this.config.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= max) {
      this.shouldReconnect = false;
      this.setState('failed');
      const error = new Error(`WebSocket reconnect failed after ${max} attempts`);
      for (const listener of this.errorListeners) {
        try { listener(error); } catch { /* ignore */ }
      }
      return;
    }

    const baseDelay = this.config.initialReconnectDelay ?? 1000;
    const maxDelay = this.config.maxReconnectDelay ?? 30_000;
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts),
      maxDelay,
    );
    // Jitter: ±25%
    const jitter = delay * (0.75 + Math.random() * 0.5);

    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
  }
}
