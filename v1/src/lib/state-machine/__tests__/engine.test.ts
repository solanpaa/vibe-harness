import { applyTransition } from '../engine';
import { taskMachine } from '../machines/task';

describe('applyTransition — persistence engine adapter', () => {
  const readState = vi.fn().mockReturnValue({
    status: 'running',
    context: { taskId: 't1', workflowRunId: 'wf1', originTaskId: null },
  });
  const writeState = vi.fn();
  const actionHandlers = {
    saveOutput: vi.fn(),
    setCompletedAt: vi.fn(),
    notifyWorkflow: vi.fn(),
    setSandboxId: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    readState.mockReturnValue({
      status: 'running',
      context: { taskId: 't1', workflowRunId: 'wf1', originTaskId: null },
    });
  });

  it('applies a valid transition and writes the new state', async () => {
    const result = await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, from: 'running', to: 'completed' }),
    );
    expect(readState).toHaveBeenCalledWith('t1');
    // writeState now receives expectedFromStatus for optimistic locking
    expect(writeState).toHaveBeenCalledWith('t1', 'completed', 'running');
  });

  it('executes action handlers in declaration order', async () => {
    const callOrder: string[] = [];
    actionHandlers.saveOutput.mockImplementation(() => callOrder.push('saveOutput'));
    actionHandlers.setCompletedAt.mockImplementation(() => callOrder.push('setCompletedAt'));
    actionHandlers.notifyWorkflow.mockImplementation(() => callOrder.push('notifyWorkflow'));

    await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(callOrder).toEqual(['saveOutput', 'setCompletedAt', 'notifyWorkflow']);
  });

  it('rejects an invalid transition without writing state', async () => {
    readState.mockReturnValue({
      status: 'completed',
      context: { taskId: 't1', workflowRunId: 'wf1', originTaskId: null },
    });

    const result = await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no valid transition/i);
    }
    expect(writeState).not.toHaveBeenCalled();
  });

  it('logs transitions with entity ID, from, to, and event', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('t1'),
    );
    const logMessage = logSpy.mock.calls[0]?.[0] as string;
    expect(logMessage).toMatch(/running/);
    expect(logMessage).toMatch(/completed/);
    expect(logMessage).toMatch(/COMPLETE/);

    logSpy.mockRestore();
  });

  it('returns full transition details on success', async () => {
    const result = await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(result).toEqual({
      ok: true,
      from: 'running',
      to: 'completed',
      event: 'COMPLETE',
    });
  });

  it('continues after action handler failure and logs the error', async () => {
    const callOrder: string[] = [];
    actionHandlers.saveOutput.mockImplementation(() => {
      callOrder.push('saveOutput');
      throw new Error('save failed');
    });
    actionHandlers.setCompletedAt.mockImplementation(() => callOrder.push('setCompletedAt'));
    actionHandlers.notifyWorkflow.mockImplementation(() => callOrder.push('notifyWorkflow'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    // Transition still succeeds (state was written)
    expect(result.ok).toBe(true);
    // DB was written before actions
    expect(writeState).toHaveBeenCalledWith('t1', 'completed', 'running');
    // saveOutput failed but setCompletedAt and notifyWorkflow still ran
    expect(callOrder).toContain('setCompletedAt');
    expect(callOrder).toContain('notifyWorkflow');
    // Error was logged
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('optimistic lock: writeState receives expectedFromStatus', async () => {
    await applyTransition({
      machine: taskMachine,
      entityId: 't1',
      event: { type: 'COMPLETE' },
      readState,
      writeState,
      actionHandlers,
    });

    expect(writeState).toHaveBeenCalledWith('t1', 'completed', 'running');
  });
});
