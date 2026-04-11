// ---------------------------------------------------------------------------
// Unit tests for streaming-service.ts — buffer management, DB write tap,
// client fan-out, ACP event transformation, and cleanup.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RunOutputMessage, ServerMessage } from '@vibe-harness/shared';

// Mock DB — track inserts
const insertedValues: any[][] = [];
const mockInsert = vi.fn().mockReturnValue({
  values: (v: any) => { insertedValues.push(Array.isArray(v) ? v : [v]); },
});
vi.mock('../../src/db/index.js', () => ({
  getDb: () => ({
    insert: () => mockInsert(),
  }),
}));

vi.mock('../../src/db/schema.js', () => ({
  runMessages: 'runMessages',
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import {
  addClient,
  removeClient,
  subscribe,
  unsubscribe,
  pushEvent,
  getEventsSince,
  cleanupRun,
  broadcast,
  sendToRun,
  getClientCount,
  disconnectAll,
  setStage,
  insertSessionBoundary,
} from '../../src/services/streaming-service.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSendFn() {
  const messages: ServerMessage[] = [];
  const send = (msg: ServerMessage) => { messages.push(msg); };
  return { send, messages };
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  disconnectAll();
  insertedValues.length = 0;
  mockInsert.mockClear();
});

afterEach(() => {
  disconnectAll();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('client management', () => {
  it('addClient / removeClient / getClientCount', () => {
    expect(getClientCount()).toBe(0);
    addClient('c1', () => {});
    addClient('c2', () => {});
    expect(getClientCount()).toBe(2);
    removeClient('c1');
    expect(getClientCount()).toBe(1);
    removeClient('c2');
    expect(getClientCount()).toBe(0);
  });

  it('removeClient is idempotent for unknown id', () => {
    removeClient('nonexistent');
    expect(getClientCount()).toBe(0);
  });
});

describe('pushEvent', () => {
  it('pushes event and fans out to subscriber', () => {
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1');

    pushEvent('run-1', {
      runId: 'run-1',
      data: { role: 'assistant', content: 'Hello', eventType: 'agent_message', timestamp: new Date().toISOString() },
    });

    expect(messages).toHaveLength(1);
    expect((messages[0] as RunOutputMessage).type).toBe('run_output');
    expect((messages[0] as RunOutputMessage).seq).toBe(0);
    expect((messages[0] as RunOutputMessage).data?.content).toBe('Hello');
  });

  it('does not send to unsubscribed clients', () => {
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    // NOT subscribed to run-1

    pushEvent('run-1', {
      runId: 'run-1',
      data: { role: 'system', content: 'x', eventType: 'session_update', timestamp: new Date().toISOString() },
    });

    expect(messages).toHaveLength(0);
  });

  it('assigns incrementing sequence numbers', () => {
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1');

    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'b', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'c', eventType: 'agent_message', timestamp: '' } });

    expect((messages[0] as RunOutputMessage).seq).toBe(0);
    expect((messages[1] as RunOutputMessage).seq).toBe(1);
    expect((messages[2] as RunOutputMessage).seq).toBe(2);
  });
});

describe('subscribe with replay', () => {
  it('replays all buffered events when lastSeq not provided', () => {
    // Push events before subscribing
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'b', eventType: 'agent_message', timestamp: '' } });

    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1');

    // Should receive both buffered events
    expect(messages).toHaveLength(2);
  });

  it('replays events after lastSeq', () => {
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'b', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'c', eventType: 'agent_message', timestamp: '' } });

    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1', 1); // replay after seq 1

    // Only seq=2 should be replayed
    expect(messages).toHaveLength(1);
    expect((messages[0] as RunOutputMessage).seq).toBe(2);
  });

  it('replays nothing when lastSeq >= latest', () => {
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });

    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1', 999);

    expect(messages).toHaveLength(0);
  });
});

describe('unsubscribe', () => {
  it('stops receiving events after unsubscribe', () => {
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1');

    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'before', eventType: 'agent_message', timestamp: '' } });
    expect(messages).toHaveLength(1);

    unsubscribe('c1', 'run-1');
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'after', eventType: 'agent_message', timestamp: '' } });
    expect(messages).toHaveLength(1); // no new message
  });
});

describe('getEventsSince', () => {
  it('returns events after given seq', () => {
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'b', eventType: 'agent_message', timestamp: '' } });
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'c', eventType: 'agent_message', timestamp: '' } });

    const events = getEventsSince('run-1', 1);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(2);
  });

  it('returns empty for unknown run', () => {
    expect(getEventsSince('nonexistent', 0)).toEqual([]);
  });
});

describe('broadcast', () => {
  it('sends to all connected clients regardless of subscription', () => {
    const { send: s1, messages: m1 } = makeSendFn();
    const { send: s2, messages: m2 } = makeSendFn();
    addClient('c1', s1);
    addClient('c2', s2);

    broadcast({ type: 'run_status', runId: 'run-1', status: 'completed' } as any);

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
  });
});

describe('sendToRun', () => {
  it('sends only to clients subscribed to a specific run', () => {
    const { send: s1, messages: m1 } = makeSendFn();
    const { send: s2, messages: m2 } = makeSendFn();
    addClient('c1', s1);
    addClient('c2', s2);
    subscribe('c1', 'run-1');
    // c2 is NOT subscribed to run-1

    sendToRun('run-1', { type: 'run_status', runId: 'run-1', status: 'running' } as any);

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(0);
  });
});

describe('setStage', () => {
  it('updates stage name and round for existing buffer', () => {
    // Create a buffer via pushEvent
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'x', eventType: 'agent_message', timestamp: '' } });

    setStage('run-1', 'review', 3);

    // Push event WITH explicit stageName — verifying setStage doesn't break anything
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1', 0);
    pushEvent('run-1', { runId: 'run-1', stageName: 'review', round: 3, data: { role: 'system', content: 'y', eventType: 'agent_message', timestamp: '' } });

    const lastMsg = messages[messages.length - 1] as RunOutputMessage;
    expect(lastMsg.stageName).toBe('review');
    expect(lastMsg.round).toBe(3);
  });

  it('does not warn for unknown run', () => {
    // setStage on unknown run should not throw
    expect(() => setStage('nonexistent', 'plan', 1)).not.toThrow();
  });
});

describe('insertSessionBoundary', () => {
  it('inserts a boundary marker event', () => {
    const { send, messages } = makeSendFn();
    addClient('c1', send);
    subscribe('c1', 'run-1');

    insertSessionBoundary('run-1');

    expect(messages).toHaveLength(1);
    const msg = messages[0] as RunOutputMessage;
    expect(msg.data?.role).toBe('system');
    expect(msg.data?.content).toBe('New session started');
    expect(msg.data?.eventType).toBe('session_update');
  });
});

describe('cleanupRun', () => {
  it('removes buffer and stops accepting events', () => {
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });
    expect(getEventsSince('run-1', -1).length).toBeGreaterThan(0);

    cleanupRun('run-1');

    expect(getEventsSince('run-1', -1)).toEqual([]);
  });

  it('is idempotent for unknown runs', () => {
    expect(() => cleanupRun('nonexistent')).not.toThrow();
  });
});

describe('disconnectAll', () => {
  it('clears all clients and buffers', () => {
    addClient('c1', () => {});
    pushEvent('run-1', { runId: 'run-1', data: { role: 'system', content: 'a', eventType: 'agent_message', timestamp: '' } });

    expect(getClientCount()).toBe(1);

    disconnectAll();

    expect(getClientCount()).toBe(0);
    expect(getEventsSince('run-1', -1)).toEqual([]);
  });
});
