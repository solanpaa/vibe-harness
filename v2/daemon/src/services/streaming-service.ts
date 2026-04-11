// ---------------------------------------------------------------------------
// Streaming Service (CDD-services §6)
//
// Per-run event buffer with sequence numbers, DB persistence tap, and
// ACP event integration. Services push events here; the WebSocket handler
// reads them for live delivery + replay on reconnect.
// ---------------------------------------------------------------------------

import type { ServerMessage, RunOutputMessage, AgentOutputEvent } from '@vibe-harness/shared';
import type { AcpClient, AcpEvent } from './acp-client.js';
import { getDb } from '../db/index.js';
import { runMessages } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const MAX_BUFFER_SIZE = 10_000;

/** DB flush interval in ms (CDD §6.2: 500ms or 50 events) */
const DB_FLUSH_INTERVAL_MS = 500;
const DB_FLUSH_BATCH_SIZE = 50;

// ── Per-run event buffer ──────────────────────────────────────────────

interface RunBuffer {
  events: RunOutputMessage[];
  seq: number; // next sequence number to assign
  /** Current stage name for tagging new events */
  stageName: string;
  /** Current round number (increments on request_changes) */
  round: number;
  /** Pending entries for batched DB persistence */
  dbWriteBuffer: DbWriteEntry[];
  /** Periodic DB flush timer */
  flushTimer: ReturnType<typeof setInterval> | null;
  /** ACP event unsubscribe handle */
  acpUnsubscribe: (() => void) | null;
}

interface DbWriteEntry {
  workflowRunId: string;
  stageName: string;
  round: number;
  sessionBoundary: boolean;
  role: string;
  content: string;
  isIntervention: boolean;
  metadata: string | null;
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
    buf = {
      events: [],
      seq: 0,
      stageName: 'unknown',
      round: 1,
      dbWriteBuffer: [],
      flushTimer: null,
      acpUnsubscribe: null,
    };
    runBuffers.set(runId, buf);
  }
  return buf;
}

// ── DB write tap (CDD §6.2) ──────────────────────────────────────────

function queueDbWrite(runId: string, buf: RunBuffer, entry: DbWriteEntry): void {
  buf.dbWriteBuffer.push(entry);

  // Start periodic flush timer on first write
  if (!buf.flushTimer) {
    buf.flushTimer = setInterval(() => {
      flushDbWrites(runId, buf);
    }, DB_FLUSH_INTERVAL_MS);
  }

  // Threshold-triggered flush — fire-and-forget with .catch() error logging
  if (buf.dbWriteBuffer.length >= DB_FLUSH_BATCH_SIZE) {
    Promise.resolve()
      .then(() => flushDbWrites(runId, buf))
      .catch((err) => {
        log.error({ runId, err }, 'Threshold-triggered DB flush failed');
      });
  }
}

function flushDbWrites(runId: string, buf: RunBuffer): void {
  if (buf.dbWriteBuffer.length === 0) return;

  const batch = buf.dbWriteBuffer.splice(0);
  try {
    const db = getDb();
    db.insert(runMessages).values(
      batch.map((entry) => ({
        workflowRunId: entry.workflowRunId,
        stageName: entry.stageName,
        round: entry.round,
        sessionBoundary: entry.sessionBoundary,
        role: entry.role,
        content: entry.content,
        isIntervention: entry.isIntervention,
        metadata: entry.metadata,
      })),
    );
  } catch (err) {
    log.error({ runId, batchSize: batch.length, err }, 'Failed to flush events to DB');
    // Re-queue failed batch at front for retry on next flush
    buf.dbWriteBuffer.unshift(...batch);
  }
}

// ── ACP event → AgentOutputEvent transformation ───────────────────────

function acpEventToAgentOutput(event: AcpEvent): AgentOutputEvent {
  const timestamp = event.receivedAt;

  switch (event.type) {
    case 'agent_message':
      return {
        role: 'assistant',
        content: String((event.data as Record<string, unknown>).content ?? ''),
        eventType: 'agent_message',
        metadata: { isStreaming: Boolean((event.data as Record<string, unknown>).partial) },
        timestamp,
      };

    case 'agent_thought':
      return {
        role: 'assistant',
        content: String((event.data as Record<string, unknown>).content ?? ''),
        eventType: 'agent_thought',
        timestamp,
      };

    case 'tool_call':
      return {
        role: 'assistant',
        content: `Tool call: ${String((event.data as Record<string, unknown>).name ?? 'unknown')}`,
        eventType: 'tool_call',
        metadata: {
          toolName: String((event.data as Record<string, unknown>).name ?? ''),
          toolCallId: String((event.data as Record<string, unknown>).id ?? ''),
          toolArgs: (event.data as Record<string, unknown>).arguments as Record<string, unknown> | undefined,
        },
        timestamp,
      };

    case 'tool_result':
      return {
        role: 'tool',
        content: String((event.data as Record<string, unknown>).output ?? ''),
        eventType: 'tool_result',
        metadata: {
          toolCallId: String((event.data as Record<string, unknown>).callId ?? ''),
        },
        timestamp,
      };

    case 'session_update':
      return {
        role: 'system',
        content: `Session ${String((event.data as Record<string, unknown>).status ?? 'update')}`,
        eventType: 'session_update',
        timestamp,
      };

    case 'result': {
      const usage = (event.data as Record<string, unknown>).usage as
        | Record<string, unknown>
        | undefined;
      return {
        role: 'system',
        content: `Result: exit code ${String((event.data as Record<string, unknown>).exitCode ?? 'unknown')}`,
        eventType: 'result',
        metadata: usage
          ? {
              usageStats: {
                tokens: usage.totalTokens as number | undefined,
                durationMs: usage.duration as number | undefined,
                model: usage.model as string | undefined,
              },
            }
          : undefined,
        timestamp,
      };
    }

    case 'error':
      return {
        role: 'system',
        content: `Error: ${String((event.data as Record<string, unknown>).message ?? JSON.stringify(event.data))}`,
        eventType: 'result',
        timestamp,
      };

    default:
      return {
        role: 'system',
        content: JSON.stringify(event.data),
        eventType: 'agent_message',
        timestamp,
      };
  }
}

// ── Broadcast to subscribed WS clients ────────────────────────────────

function fanOutToSubscribers(runId: string, message: ServerMessage): void {
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
 * Push an event for a run. Buffers it, persists to DB, and broadcasts
 * to subscribed WS clients.
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

  // Add to in-memory buffer, evict oldest if over limit
  buf.events.push(message);
  if (buf.events.length > MAX_BUFFER_SIZE) {
    buf.events.shift();
  }

  // Queue for DB persistence
  queueDbWrite(runId, buf, {
    workflowRunId: runId,
    stageName: message.stageName ?? buf.stageName,
    round: message.round ?? buf.round,
    sessionBoundary: false,
    role: message.data?.role ?? 'system',
    content: message.data?.content ?? '',
    isIntervention: false,
    metadata: message.data?.metadata ? JSON.stringify(message.data.metadata) : null,
  });

  // Fan out to subscribed WS clients
  fanOutToSubscribers(runId, message);
}

/**
 * Register an ACP event stream for a run (CDD §6.2).
 * Subscribes to ACP events from the given sandbox, transforms them to
 * RunOutputMessage, and pushes to both WS broadcast and DB write buffer.
 */
export function registerAcpStream(
  runId: string,
  sandboxName: string,
  acpClient: AcpClient,
  stageName: string,
  round: number,
): void {
  const buf = getOrCreateBuffer(runId);
  buf.stageName = stageName;
  buf.round = round;

  // Tear down any previous ACP subscription for this run
  if (buf.acpUnsubscribe) {
    buf.acpUnsubscribe();
    buf.acpUnsubscribe = null;
  }

  log.info({ runId, sandboxName, stageName, round }, 'Registering ACP stream');

  const unsubscribe = acpClient.onEvent(sandboxName, (event: AcpEvent) => {
    const agentOutput = acpEventToAgentOutput(event);
    const seq = buf.seq++;

    const message: RunOutputMessage = {
      type: 'run_output',
      runId,
      seq,
      stageName: buf.stageName,
      round: buf.round,
      data: agentOutput,
    };

    // Add to in-memory buffer
    if (buf.events.length >= MAX_BUFFER_SIZE) {
      buf.events.shift();
    }
    buf.events.push(message);

    // Queue for DB persistence
    queueDbWrite(runId, buf, {
      workflowRunId: runId,
      stageName: buf.stageName,
      round: buf.round,
      sessionBoundary: false,
      role: agentOutput.role,
      content: agentOutput.content,
      isIntervention: false,
      metadata: agentOutput.metadata ? JSON.stringify(agentOutput.metadata) : null,
    });

    // Fan out to subscribed WS clients
    fanOutToSubscribers(runId, message);
  });

  buf.acpUnsubscribe = unsubscribe;
}

/**
 * Update the current stage name and round for a run's stream (CDD §6.1).
 * Called when advancing to a new stage or round within the same sandbox.
 */
export function setStage(runId: string, stageName: string, round: number): void {
  const buf = runBuffers.get(runId);
  if (!buf) {
    log.warn({ runId, stageName, round }, 'setStage called for unknown run');
    return;
  }

  buf.stageName = stageName;
  buf.round = round;
  log.debug({ runId, stageName, round }, 'Stage updated');
}

/**
 * Insert a session boundary marker into the message log.
 * Called when a freshSession starts (e.g. new --continue round).
 */
export function insertSessionBoundary(runId: string): void {
  const buf = getOrCreateBuffer(runId);
  const seq = buf.seq++;

  const boundaryData: AgentOutputEvent = {
    role: 'system',
    content: 'New session started',
    eventType: 'session_update',
    timestamp: new Date().toISOString(),
  };

  const message: RunOutputMessage = {
    type: 'run_output',
    runId,
    seq,
    stageName: buf.stageName,
    round: buf.round,
    data: boundaryData,
  };

  // Add to in-memory buffer
  if (buf.events.length >= MAX_BUFFER_SIZE) {
    buf.events.shift();
  }
  buf.events.push(message);

  // Queue a DB entry with sessionBoundary flag
  queueDbWrite(runId, buf, {
    workflowRunId: runId,
    stageName: buf.stageName,
    round: buf.round,
    sessionBoundary: true,
    role: 'system',
    content: 'New session started',
    isIntervention: false,
    metadata: null,
  });

  // Notify subscribed clients
  fanOutToSubscribers(runId, message);
  log.debug({ runId, stageName: buf.stageName, round: buf.round }, 'Session boundary inserted');
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
  fanOutToSubscribers(runId, message);
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
 * Flushes pending DB writes and tears down ACP subscription.
 * Call after the run reaches a terminal state + a grace period.
 */
export function cleanupRun(runId: string): void {
  const buf = runBuffers.get(runId);
  if (buf) {
    // Flush remaining DB writes
    flushDbWrites(runId, buf);

    // Tear down flush timer
    if (buf.flushTimer) {
      clearInterval(buf.flushTimer);
      buf.flushTimer = null;
    }

    // Tear down ACP subscription
    if (buf.acpUnsubscribe) {
      buf.acpUnsubscribe();
      buf.acpUnsubscribe = null;
    }
  }

  runBuffers.delete(runId);
  log.debug({ runId }, 'Run buffer cleaned up');
}

/**
 * Get the number of connected clients (for health/metrics).
 */
export function getClientCount(): number {
  return clients.size;
}
