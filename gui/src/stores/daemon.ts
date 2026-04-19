import { create } from "zustand";
import { DaemonClient, resetConnection } from "../api/client";
import type { HealthResponse } from "@vibe-harness/shared";

/** Fixed daemon port — must match daemon's DEFAULT_PORT. */
const DAEMON_PORT = 19423;

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
    const { client, port } = get();

    if (!client) {
      // Self-heal: try reconnecting on the fixed port with a fresh token.
      // This handles the case where the daemon restarted with a new token
      // and our old client was discarded.
      try {
        resetConnection();
        const tempClient = new DaemonClient(port ?? DAEMON_PORT);
        const health = await tempClient.health();
        set({
          port: port ?? DAEMON_PORT,
          connected: true,
          client: tempClient,
          lastHealthCheck: health,
          lastError: null,
        });
      } catch {
        // Daemon not available — stay disconnected
      }
      return;
    }

    try {
      const health = await client.health();
      set({ lastHealthCheck: health, connected: true, lastError: null });
    } catch {
      // Health check failed — clear token cache and try once more with fresh token
      resetConnection();
      try {
        const freshClient = new DaemonClient(port ?? DAEMON_PORT);
        const health = await freshClient.health();
        set({
          connected: true,
          client: freshClient,
          lastHealthCheck: health,
          lastError: null,
        });
      } catch (retryErr) {
        set({
          connected: false,
          lastHealthCheck: null,
          lastError: retryErr instanceof Error ? retryErr.message : "Health check failed",
          client: null,
        });
      }
    }
  },
}));
