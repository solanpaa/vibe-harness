// ---------------------------------------------------------------------------
// Streaming Store (CDD-gui §5.2)
//
// Zustand store for per-run WebSocket streaming data. Buffers incoming
// events and provides subscribe/unsubscribe helpers.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type { ServerMessage, RunOutputMessage } from '@vibe-harness/shared';
import type { WebSocketManager, WebSocketState } from '../api/ws';
import type { DaemonClient } from '../api/client';

const MAX_CLIENT_BUFFER = 5_000; // Max events per run on client side

interface RunBuffer {
  events: RunOutputMessage[];
  lastSeq: number;
}

interface StreamingState {
  /** Per-run event buffers */
  buffers: Map<string, RunBuffer>;
  /** WebSocket connection state */
  wsState: WebSocketState;
  /** Runs requiring resync via REST */
  resyncRequired: Set<string>;

  // ── Actions ──
  /** Handle an incoming server message */
  handleMessage: (msg: ServerMessage) => void;
  /** Update WS connection state */
  setWsState: (state: WebSocketState) => void;
  /** Subscribe to a run (sends WS subscribe + creates buffer) */
  subscribe: (runId: string, ws: WebSocketManager) => void;
  /** Unsubscribe from a run (sends WS unsubscribe + optionally clears buffer) */
  unsubscribe: (runId: string, ws: WebSocketManager) => void;
  /** Clear resync flag after REST fetch completes */
  clearResync: (runId: string) => void;
  /** Clear a run's buffer */
  clearBuffer: (runId: string) => void;
}

export const useStreamingStore = create<StreamingState>((set, get) => ({
  buffers: new Map(),
  wsState: 'closed',
  resyncRequired: new Set(),

  handleMessage: (msg: ServerMessage) => {
    switch (msg.type) {
      case 'run_output': {
        set((state) => {
          const buffers = new Map(state.buffers);
          const existing = buffers.get(msg.runId) ?? { events: [], lastSeq: -1 };

          // Drop duplicate or out-of-order events
          if (existing.lastSeq >= 0 && msg.seq <= existing.lastSeq) return state;

          const events = [...existing.events, msg];
          // Trim oldest events if over client buffer limit
          if (events.length > MAX_CLIENT_BUFFER) {
            events.splice(0, events.length - MAX_CLIENT_BUFFER);
          }

          buffers.set(msg.runId, { events, lastSeq: msg.seq });
          return { buffers };
        });
        break;
      }

      case 'resync_required': {
        set((state) => {
          const resyncRequired = new Set(state.resyncRequired);
          resyncRequired.add(msg.runId);
          return { resyncRequired };
        });
        break;
      }

      // Other message types (run_status, stage_status, review_created, etc.)
      // are handled by other stores — this store only manages streaming buffers.
    }
  },

  setWsState: (wsState: WebSocketState) => set({ wsState }),

  subscribe: (runId: string, ws: WebSocketManager) => {
    const { buffers } = get();
    const existing = buffers.get(runId);
    const lastSeq = existing?.lastSeq ?? undefined;

    // Create buffer if not exists
    if (!existing) {
      set((state) => {
        const newBuffers = new Map(state.buffers);
        newBuffers.set(runId, { events: [], lastSeq: -1 });
        return { buffers: newBuffers };
      });
    }

    ws.subscribe(runId, lastSeq !== undefined && lastSeq >= 0 ? lastSeq : undefined);
  },

  unsubscribe: (runId: string, ws: WebSocketManager) => {
    ws.unsubscribe(runId);
  },

  clearResync: (runId: string) => {
    set((state) => {
      const resyncRequired = new Set(state.resyncRequired);
      resyncRequired.delete(runId);
      return { resyncRequired };
    });
  },

  clearBuffer: (runId: string) => {
    set((state) => {
      const buffers = new Map(state.buffers);
      buffers.delete(runId);
      return { buffers };
    });
  },
}));

/**
 * Fetch all messages for a run via REST and replace the streaming buffer.
 * Call this when `resyncRequired` is set for a runId.
 */
export async function resyncFromRest(runId: string, apiClient: DaemonClient): Promise<void> {
  const { messages } = await apiClient.getRunMessages(runId);
  const store = useStreamingStore.getState();

  // Convert RunMessage[] to RunOutputMessage[] for the buffer
  const events: RunOutputMessage[] = messages.map((m, i) => ({
    type: 'run_output' as const,
    runId,
    seq: i,
    stageName: m.stageName,
    round: m.round,
    data: {
      role: m.role,
      content: m.content,
      eventType: (m.metadata?.eventType as RunOutputMessage['data']['eventType']) ?? 'agent_message',
      metadata: m.metadata ? {
        toolName: m.metadata.toolName,
        toolCallId: m.metadata.toolCallId,
        toolArgs: m.metadata.toolArgs,
      } : undefined,
      timestamp: m.createdAt,
    },
  }));

  useStreamingStore.setState((state) => {
    const buffers = new Map(state.buffers);
    buffers.set(runId, { events, lastSeq: events.length - 1 });
    const resyncRequired = new Set(state.resyncRequired);
    resyncRequired.delete(runId);
    return { buffers, resyncRequired };
  });

  // Clear the flag via the action as well for consistency
  store.clearResync(runId);
}
