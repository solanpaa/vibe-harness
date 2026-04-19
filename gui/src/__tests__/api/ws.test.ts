import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketManager, type WebSocketConfig } from "../../api/ws";

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    // Fire onclose asynchronously to match real WebSocket
    setTimeout(() => this.onclose?.({} as CloseEvent), 0);
  }

  // Test helper: simulate server opening
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  // Test helper: simulate server message
  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  // Test helper: simulate close
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }
}

// Install mock globally
const originalWebSocket = globalThis.WebSocket;

function makeConfig(overrides: Partial<WebSocketConfig> = {}): WebSocketConfig {
  return {
    getUrl: () => "ws://127.0.0.1:9876/ws",
    getAuthToken: () => "my-token",
    initialReconnectDelay: 10, // fast for tests
    maxReconnectDelay: 100,
    maxReconnectAttempts: 3,
    ...overrides,
  };
}

describe("WebSocketManager", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("connect() creates WebSocket with correct URL + token", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe(
      "ws://127.0.0.1:9876/ws?token=my-token"
    );
  });

  it("connect() encodes token in URL", () => {
    const ws = new WebSocketManager(
      makeConfig({ getAuthToken: () => "token with spaces" })
    );
    ws.connect();

    expect(MockWebSocket.instances[0].url).toContain("token%20with%20spaces");
  });

  it("subscribe sends correct ClientMessage when connected", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.subscribe("run-1", 42);

    const sent = JSON.parse(MockWebSocket.instances[0].sent[0]);
    expect(sent).toEqual({ type: "subscribe", runId: "run-1", lastSeq: 42 });
  });

  it("subscribe without lastSeq omits it from message", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.subscribe("run-1");

    const sent = JSON.parse(MockWebSocket.instances[0].sent[0]);
    expect(sent).toEqual({ type: "subscribe", runId: "run-1" });
    expect(sent.lastSeq).toBeUndefined();
  });

  it("unsubscribe sends correct ClientMessage", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.unsubscribe("run-1");

    const sent = JSON.parse(MockWebSocket.instances[0].sent[0]);
    expect(sent).toEqual({ type: "unsubscribe", runId: "run-1" });
  });

  it("dispatches messages to onMessage listeners", () => {
    const ws = new WebSocketManager(makeConfig());
    const listener = vi.fn();
    ws.onMessage(listener);

    ws.connect();
    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[0].simulateMessage({
      type: "run_status",
      runId: "run-1",
      status: "running",
      currentStage: "plan",
      title: "Test",
      projectId: "p1",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].type).toBe("run_status");
  });

  it("onMessage returns unsubscribe function", () => {
    const ws = new WebSocketManager(makeConfig());
    const listener = vi.fn();
    const unsub = ws.onMessage(listener);

    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    unsub();

    MockWebSocket.instances[0].simulateMessage({
      type: "pong",
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("fires state change listeners on connect/open", () => {
    const ws = new WebSocketManager(makeConfig());
    const states: string[] = [];
    ws.onStateChange((s) => states.push(s));

    ws.connect();
    expect(states).toContain("connecting");

    MockWebSocket.instances[0].simulateOpen();
    expect(states).toContain("open");
  });

  it("attempts reconnect with backoff after unexpected close", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    // Simulate unexpected close
    MockWebSocket.instances[0].simulateClose();

    expect(ws.state).toBe("reconnecting");

    // Advance timer to trigger reconnect
    vi.advanceTimersByTime(200);

    // Should have created a second WebSocket
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("maxReconnectAttempts limits retries then sets state to failed", () => {
    const ws = new WebSocketManager(makeConfig({ maxReconnectAttempts: 2 }));
    const errorListener = vi.fn();
    ws.onError(errorListener);

    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    // Close and exhaust retries
    for (let i = 0; i < 3; i++) {
      const lastInstance = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      lastInstance.simulateClose();
      vi.advanceTimersByTime(10_000);
    }

    expect(ws.state).toBe("failed");
    expect(errorListener).toHaveBeenCalled();
    expect(errorListener.mock.calls[0][0].message).toContain("failed after 2 attempts");
  });

  it("disconnect() with shouldReconnect=false stops retrying", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.disconnect();

    expect(ws.state).toBe("closed");

    // Advance time — should not create new connections
    vi.advanceTimersByTime(60_000);
    // Only the original WS instance should exist
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("reconnectToNewUrl updates config and reconnects", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.reconnectToNewUrl(
      () => "ws://127.0.0.1:5555/ws",
      () => "new-token"
    );

    // Should eventually create a new WS with new URL
    const lastInstance = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastInstance.url).toContain("5555");
    expect(lastInstance.url).toContain("new-token");
  });

  it("resubscribes all tracked runs after reconnect", () => {
    const ws = new WebSocketManager(makeConfig());
    ws.connect();
    MockWebSocket.instances[0].simulateOpen();

    ws.subscribe("run-1", 10);
    ws.subscribe("run-2", 20);

    // Simulate reconnect
    MockWebSocket.instances[0].simulateClose();
    vi.advanceTimersByTime(200);

    const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    newWs.simulateOpen();

    // Should have resubscribed with lastSeq
    const sentMessages = newWs.sent.map((s) => JSON.parse(s));
    const runIds = sentMessages
      .filter((m: { type: string }) => m.type === "subscribe")
      .map((m: { runId: string }) => m.runId);
    expect(runIds).toContain("run-1");
    expect(runIds).toContain("run-2");
  });
});
