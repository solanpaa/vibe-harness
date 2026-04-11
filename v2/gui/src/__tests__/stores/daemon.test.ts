import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api/client module before importing the store
vi.mock("../../api/client", () => {
  const MockDaemonClient = vi.fn().mockImplementation(function (this: Record<string, unknown>, port: number) {
    this.port = port;
    this.health = vi.fn().mockResolvedValue({ status: "ok", version: "1.0.0", uptime: 100 });
  });
  return {
    DaemonClient: MockDaemonClient,
    setCachedPort: vi.fn(),
    resetConnection: vi.fn(),
    getDaemonPort: vi.fn().mockResolvedValue(null),
  };
});

import { useDaemonStore } from "../../stores/daemon";
import { resetConnection } from "../../api/client";

function getState() {
  return useDaemonStore.getState();
}

describe("Daemon store", () => {
  beforeEach(() => {
    // Reset store to initial state between tests
    useDaemonStore.setState({
      port: null,
      connected: false,
      lastHealthCheck: null,
      lastError: null,
      client: null,
    });
    vi.clearAllMocks();
  });

  it("starts in disconnected state", () => {
    expect(getState().connected).toBe(false);
    expect(getState().port).toBeNull();
    expect(getState().client).toBeNull();
  });

  it("setConnected transitions to connected with a client", () => {
    getState().setConnected(9876);

    expect(getState().connected).toBe(true);
    expect(getState().port).toBe(9876);
    expect(getState().client).not.toBeNull();
    expect(getState().lastError).toBeNull();
  });

  it("setDisconnected clears connection state", () => {
    getState().setConnected(9876);
    getState().setDisconnected("connection lost");

    expect(getState().connected).toBe(false);
    expect(getState().client).toBeNull();
    expect(getState().lastError).toBe("connection lost");
    expect(resetConnection).toHaveBeenCalled();
  });

  it("setDisconnected without error sets lastError to null", () => {
    getState().setConnected(9876);
    getState().setDisconnected();

    expect(getState().lastError).toBeNull();
  });

  it("setHealthCheck stores health response", () => {
    const health = { status: "ok" as const, version: "1.0.0", uptime: 42 };
    getState().setHealthCheck(health);

    expect(getState().lastHealthCheck).toEqual(health);
  });
});
