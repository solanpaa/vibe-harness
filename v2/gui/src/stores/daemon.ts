import { create } from "zustand";
import { DaemonClient, setCachedPort, resetConnection, getDaemonPort } from "../api/client";
import type { HealthResponse } from "@vibe-harness/shared";

interface DaemonState {
  port: number | null;
  connected: boolean;
  lastHealthCheck: HealthResponse | null;
  lastError: string | null;
  client: DaemonClient | null;

  setConnected: (port: number) => void;
  setDisconnected: (error?: string) => void;
  setHealthCheck: (health: HealthResponse) => void;
  checkHealth: () => Promise<void>;
}

export const useDaemonStore = create<DaemonState>((set, get) => ({
  port: null,
  connected: false,
  lastHealthCheck: null,
  lastError: null,
  client: null,

  setConnected: (port: number) => {
    resetConnection(); // Clear cached token so new client reads fresh token
    setCachedPort(port);
    set({
      port,
      connected: true,
      lastError: null,
      client: new DaemonClient(port),
    });
  },

  setDisconnected: (error?: string) => {
    resetConnection();
    set({
      connected: false,
      lastHealthCheck: null,
      lastError: error ?? null,
      client: null,
    });
  },

  setHealthCheck: (health: HealthResponse) => {
    set({ lastHealthCheck: health });
  },

  checkHealth: async () => {
    const { client } = get();

    if (!client) {
      // Self-healing: try to discover a running daemon
      try {
        resetConnection(); // Clear stale token before reconnecting
        const port = await getDaemonPort();
        if (!port) return;
        const tempClient = new DaemonClient(port);
        const health = await tempClient.health();
        setCachedPort(port);
        set({
          port,
          connected: true,
          client: tempClient,
          lastHealthCheck: health,
          lastError: null,
        });
      } catch {
        // Daemon not available yet — stay disconnected
      }
      return;
    }

    try {
      const health = await client.health();
      set({ lastHealthCheck: health, connected: true, lastError: null });
    } catch (err) {
      resetConnection();
      set({
        connected: false,
        lastHealthCheck: null,
        lastError: err instanceof Error ? err.message : "Health check failed",
        client: null,
      });
    }
  },
}));
