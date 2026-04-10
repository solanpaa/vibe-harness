import { createActor } from 'xstate';
import { taskMachine } from '../machines/task';
import type { TaskEvent } from '../types';

const defaultInput = { taskId: 'test-1', workflowRunId: 'wf-1', originTaskId: null };

function startActor(input = defaultInput) {
  const actor = createActor(taskMachine, { input });
  actor.start();
  return actor;
}

function actionNames(state: string, event: { type: string }) {
  // Use createActor with a resolved snapshot to start at the desired state
  const snapshot = taskMachine.resolveState({
    value: state,
    context: defaultInput,
  });
  const actor = createActor(taskMachine, { input: defaultInput, snapshot });
  actor.start();

  // Subscribe to capture the transition
  const beforeValue = actor.getSnapshot().value;
  actor.send(event as TaskEvent);
  const afterSnapshot = actor.getSnapshot();

  // In xstate v5 with createActor, actions are executed inline.
  // We need a different approach: use the machine definition to inspect actions.
  // Re-create the transition using the actor's internal snapshot.
  const prevSnapshot = taskMachine.resolveState({
    value: state,
    context: defaultInput,
  });

  // Use getNextSnapshot which is the v5 way to inspect transitions
  const { getNextSnapshot } = require('xstate');
  const nextSnap = getNextSnapshot(taskMachine, prevSnapshot, event as TaskEvent);
  // Actions are on the snapshot's _nodes - but we need the transition actions.
  // Let's use a simpler approach: track which actions fire via provide()
  return getActionNamesViaProvide(state, event);
}

function getActionNamesViaProvide(state: string, event: { type: string }): string[] {
  const fired: string[] = [];
  const trackedMachine = taskMachine.provide({
    actions: {
      saveOutput: () => { fired.push('saveOutput'); },
      setCompletedAt: () => { fired.push('setCompletedAt'); },
      setSandboxId: () => { fired.push('setSandboxId'); },
      notifyWorkflow: () => { fired.push('notifyWorkflow'); },
    },
  });

  const snapshot = trackedMachine.resolveState({
    value: state,
    context: defaultInput,
  });
  const actor = createActor(trackedMachine, { input: defaultInput, snapshot });
  actor.start();
  actor.send(event as TaskEvent);
  return fired;
}

// ---------- Happy paths ----------

describe('happy paths', () => {
  it('starts in pending state', () => {
    const actor = startActor();
    expect(actor.getSnapshot().value).toBe('pending');
  });

  it('pending → PROVISION → provisioning', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    expect(actor.getSnapshot().value).toBe('provisioning');
  });

  it('provisioning → START → running', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    expect(actor.getSnapshot().value).toBe('running');
  });

  it('running → COMPLETE → completed', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'COMPLETE', output: 'done' });
    expect(actor.getSnapshot().value).toBe('completed');
  });

  it('running → PAUSE → paused', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'PAUSE' });
    expect(actor.getSnapshot().value).toBe('paused');
  });

  it('paused → RESUME → running', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'PAUSE' });
    actor.send({ type: 'RESUME' });
    expect(actor.getSnapshot().value).toBe('running');
  });

  it('full lifecycle: pending → provisioning → running → completed', () => {
    const actor = startActor();
    expect(actor.getSnapshot().value).toBe('pending');

    actor.send({ type: 'PROVISION' });
    expect(actor.getSnapshot().value).toBe('provisioning');

    actor.send({ type: 'START', sandboxId: 'sb-1' });
    expect(actor.getSnapshot().value).toBe('running');

    actor.send({ type: 'COMPLETE', output: 'all good' });
    expect(actor.getSnapshot().value).toBe('completed');
  });
});

// ---------- Failure paths ----------

describe('failure paths', () => {
  it('pending → FAIL → failed', () => {
    const actor = startActor();
    actor.send({ type: 'FAIL', error: 'bad config' });
    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('provisioning → FAIL → failed', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'FAIL', error: 'no docker' });
    expect(actor.getSnapshot().value).toBe('failed');
  });

  it('running → FAIL → failed', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'FAIL', error: 'crash' });
    expect(actor.getSnapshot().value).toBe('failed');
  });
});

// ---------- Cancellation ----------

describe('cancellation', () => {
  it('pending → CANCEL → cancelled', () => {
    const actor = startActor();
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('cancelled');
  });

  it('provisioning → CANCEL → cancelled', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('cancelled');
  });

  it('running → CANCEL → cancelled', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('cancelled');
  });

  it('paused → CANCEL → cancelled', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'PAUSE' });
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('cancelled');
  });
});

// ---------- Invalid transitions ----------

describe('invalid transitions (stay in current state)', () => {
  it('completed + any event → stays completed', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'COMPLETE', output: 'done' });

    for (const type of ['PROVISION', 'START', 'COMPLETE', 'FAIL', 'CANCEL', 'PAUSE', 'RESUME']) {
      actor.send({ type } as { type: string });
      expect(actor.getSnapshot().value).toBe('completed');
    }
  });

  it('failed + any event → stays failed', () => {
    const actor = startActor();
    actor.send({ type: 'FAIL', error: 'oops' });

    for (const type of ['PROVISION', 'START', 'COMPLETE', 'FAIL', 'CANCEL', 'PAUSE', 'RESUME']) {
      actor.send({ type } as { type: string });
      expect(actor.getSnapshot().value).toBe('failed');
    }
  });

  it('cancelled + any event → stays cancelled', () => {
    const actor = startActor();
    actor.send({ type: 'CANCEL' });

    for (const type of ['PROVISION', 'START', 'COMPLETE', 'FAIL', 'CANCEL', 'PAUSE', 'RESUME']) {
      actor.send({ type } as { type: string });
      expect(actor.getSnapshot().value).toBe('cancelled');
    }
  });

  it('pending + START → stays pending (must PROVISION first)', () => {
    const actor = startActor();
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    expect(actor.getSnapshot().value).toBe('pending');
  });

  it('pending + COMPLETE → stays pending', () => {
    const actor = startActor();
    actor.send({ type: 'COMPLETE', output: 'nope' });
    expect(actor.getSnapshot().value).toBe('pending');
  });

  it('paused + COMPLETE → stays paused', () => {
    const actor = startActor();
    actor.send({ type: 'PROVISION' });
    actor.send({ type: 'START', sandboxId: 'sb-1' });
    actor.send({ type: 'PAUSE' });
    actor.send({ type: 'COMPLETE', output: 'nope' });
    expect(actor.getSnapshot().value).toBe('paused');
  });
});

// ---------- Actions fired ----------

describe('actions fired on transitions', () => {
  it('COMPLETE fires saveOutput, setCompletedAt, notifyWorkflow', () => {
    const actions = actionNames('running', { type: 'COMPLETE' });
    expect(actions).toContain('saveOutput');
    expect(actions).toContain('setCompletedAt');
    expect(actions).toContain('notifyWorkflow');
  });

  it('FAIL from running fires saveOutput, setCompletedAt, notifyWorkflow', () => {
    const actions = actionNames('running', { type: 'FAIL' });
    expect(actions).toContain('saveOutput');
    expect(actions).toContain('setCompletedAt');
    expect(actions).toContain('notifyWorkflow');
  });

  it('FAIL from pending fires only setCompletedAt', () => {
    const actions = actionNames('pending', { type: 'FAIL' });
    expect(actions).toContain('setCompletedAt');
    expect(actions).not.toContain('saveOutput');
    expect(actions).not.toContain('notifyWorkflow');
  });

  it('FAIL from provisioning fires only setCompletedAt', () => {
    const actions = actionNames('provisioning', { type: 'FAIL' });
    expect(actions).toContain('setCompletedAt');
    expect(actions).not.toContain('saveOutput');
    expect(actions).not.toContain('notifyWorkflow');
  });

  it('CANCEL from running fires setCompletedAt', () => {
    const actions = actionNames('running', { type: 'CANCEL' });
    expect(actions).toContain('setCompletedAt');
  });

  it('CANCEL from pending fires setCompletedAt', () => {
    const actions = actionNames('pending', { type: 'CANCEL' });
    expect(actions).toContain('setCompletedAt');
  });

  it('CANCEL from provisioning fires setCompletedAt', () => {
    const actions = actionNames('provisioning', { type: 'CANCEL' });
    expect(actions).toContain('setCompletedAt');
  });

  it('CANCEL from paused fires setCompletedAt', () => {
    const actions = actionNames('paused', { type: 'CANCEL' });
    expect(actions).toContain('setCompletedAt');
  });

  it('START fires setSandboxId', () => {
    const actions = actionNames('provisioning', { type: 'START' });
    expect(actions).toContain('setSandboxId');
  });

  it('PAUSE fires no actions', () => {
    const actions = actionNames('running', { type: 'PAUSE' });
    expect(actions).toHaveLength(0);
  });

  it('RESUME fires no actions', () => {
    const actions = actionNames('paused', { type: 'RESUME' });
    expect(actions).toHaveLength(0);
  });

  it('PROVISION fires no actions', () => {
    const actions = actionNames('pending', { type: 'PROVISION' });
    expect(actions).toHaveLength(0);
  });
});
