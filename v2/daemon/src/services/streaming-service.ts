// ---------------------------------------------------------------------------
// Streaming Service (CDD-api §12)
//
// Per-run event buffer with sequence numbers. Services push events here;
// the WebSocket handler reads them for live delivery + replay on reconnect.
// ---------------------------------------------------------------------------

import type { ServerMessage, RunOutputMessage } from '@vibe-harness/shared';
import { logger } from '../lib/logger.js';

const MAX_BUFFER_SIZE = 10_000;

// ── Per-run event buffer ──────────────────────────────────────────────

interface RunBuffer {
  events: RunOutputMessage[];
  seq: number; // next sequence number to assign
}

// ── Client tracking ───────────────────────────────────────────────────

type SendFn = (msg: ServerMessage) => void;

interface ConnectedClient {
  id: string;
  send: SendFn;
  subscribedRuns: Set<string>;
}

// ── Service state ─────────────────────────────────────────────────────

const runBuffers = new Map<string, RunBuffer>();
const clients = new Map<string, ConnectedClient>();

const log = logger.child({ service: 'streaming' });

// ── Buffer management ─────────────────────────────────────────────────

function getOrCreateBuffer(runId: string): RunBuffer {
  let buf = runBuffers.get(runId);
  if (!buf) {
    buf = { events: [], seq: 0 };
    runBuffers.set(runId, buf);
  }
  return buf;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Register a new WebSocket client. Called on WS open.
 */
export function addClient(clientId: string, send: SendFn): void {
  clients.set(clientId, { id: clientId, send, subscribedRuns: new Set() });
  log.debug({ clientId }, 'Client connected');
}

/**
 * Remove a WebSocket client. Called on WS close.
 */
export function removeClient(clientId: string): void {
  clients.delete(clientId);
  log.debug({ clientId }, 'Client disconnected');
}

/**
 * Subscribe a client to a run's output stream.
 * If lastSeq is provided, replays buffered events from that point.
 */
export function subscribe(clientId: string, runId: string, lastSeq?: number): void {
  const client = clients.get(clientId);
  if (!client) return;

  client.subscribedRuns.add(runId);
  log.debug({ clientId, runId, lastSeq }, 'Client subscribed');

  // Replay buffered events if lastSeq provided
  if (lastSeq !== undefined && lastSeq >= 0) {
    const buf = runBuffers.get(runId);
    if (!buf) return;

    // Check if we can replay (buffer hasn't rolled over past lastSeq)
    const oldestSeq = buf.events.length > 0 ? buf.events[0].seq : 0;
    if (lastSeq < oldestSeq) {
      // Buffer overflow — client must resync via REST
      client.send({
        type: 'resync_required',
        runId,
        reason: `Event buffer rolled over. Oldest available seq: ${oldestSeq}, requested: ${lastSeq}`,
      });
      return;
    }

    // Replay events after lastSeq
    for (const event of buf.events) {
      if (event.seq > lastSeq) {
        client.send(event);
      }
    }
  }
}

/**
 * Unsubscribe a client from a run's output stream.
 */
export function unsubscribe(clientId: string, runId: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  client.subscribedRuns.delete(runId);
  log.debug({ clientId, runId }, 'Client unsubscribed');
}

/**
 * Push an event for a run. Buffers it and broadcasts to subscribed clients.
 * Used by ACP client / workflow engine to stream agent output.
 */
export function pushEvent(
  runId: string,
  data: Omit<RunOutputMessage, 'type' | 'seq'>,
): void {
  const buf = getOrCreateBuffer(runId);
  const seq = buf.seq++;

  const message: RunOutputMessage = {
    type: 'run_output',
    seq,
    ...data,
    runId,
  };

  // Add to buffer, evict oldest if over limit
  buf.events.push(message);
  if (buf.events.length > MAX_BUFFER_SIZE) {
    buf.events.shift();
  }

  // Send to subscribed clients
  for (const client of clients.values()) {
    if (client.subscribedRuns.has(runId)) {
      try {
        client.send(message);
      } catch {
        log.warn({ clientId: client.id }, 'Failed to send to client');
      }
    }
  }
}

/**
 * Broadcast a message to ALL connected clients (run_status, review_created, etc.).
 * Used for global notifications that don't require subscription.
 */
export function broadcast(message: ServerMessage): void {
  for (const client of clients.values()) {
    try {
      client.send(message);
    } catch {
      log.warn({ clientId: client.id }, 'Failed to broadcast to client');
    }
  }
}

/**
 * Send a message to all clients subscribed to a specific run.
 */
export function sendToRun(runId: string, message: ServerMessage): void {
  for (const client of clients.values()) {
    if (client.subscribedRuns.has(runId)) {
      try {
        client.send(message);
      } catch {
        log.warn({ clientId: client.id }, 'Failed to send to client');
      }
    }
  }
}

/**
 * Get buffered events since a given sequence number.
 * Used for REST-based replay on reconnect.
 */
export function getEventsSince(runId: string, seq: number): RunOutputMessage[] {
  const buf = runBuffers.get(runId);
  if (!buf) return [];
  return buf.events.filter((e) => e.seq > seq);
}

/**
 * Clean up buffer for a completed/cancelled run.
 * Call after the run reaches a terminal state + a grace period.
 */
export function cleanupRun(runId: string): void {
  runBuffers.delete(runId);
  log.debug({ runId }, 'Run buffer cleaned up');
}

/**
 * Get the number of connected clients (for health/metrics).
 */
export function getClientCount(): number {
  return clients.size;
}
