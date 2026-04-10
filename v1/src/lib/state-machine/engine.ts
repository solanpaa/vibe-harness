import { createActor } from "xstate";
import type { AnyStateMachine } from "xstate";
import type { TransitionResult, ActionHandler } from "./types";

/**
 * Generic persistence engine for xstate state machines.
 *
 * Bridges xstate's pure transition model to our SQLite DB:
 * 1. Read current state from DB (via readState callback)
 * 2. Compute next state using xstate createActor + snapshot
 * 3. Validate — if no valid transition, return error
 * 4. Write new state to DB + execute actions atomically
 * 5. Log the transition
 *
 * Concurrency: writeState receives expectedFromStatus for optimistic
 * locking. Callers should implement a version check or WHERE status = expected.
 */
export async function applyTransition<
  TContext extends Record<string, unknown>,
  TEvent extends { type: string },
>(opts: {
  machine: AnyStateMachine;
  entityId: string;
  event: TEvent;
  readState: (id: string) => { status: string; context: TContext } | Promise<{ status: string; context: TContext }>;
  /** Write new state. Receives expectedFromStatus for optimistic locking.
   *  Should throw if current DB status !== expectedFromStatus. */
  writeState: (id: string, status: string, expectedFromStatus: string) => void | Promise<void>;
  actionHandlers: Record<string, ActionHandler<TContext, TEvent>>;
}): Promise<TransitionResult> {
  const { machine, entityId, event, readState, writeState, actionHandlers } =
    opts;

  // 1. Read current state
  const current = await readState(entityId);
  const fromValue = current.status;

  // 2. Track which actions fire by providing instrumented action implementations
  const firedActions: string[] = [];
  const trackedMachine = machine.provide({
    actions: Object.fromEntries(
      Object.keys(actionHandlers).map((name) => [
        name,
        () => { firedActions.push(name); },
      ]),
    ),
  });

  // 3. Resolve snapshot at current state and send event via actor
  const snapshot = trackedMachine.resolveState({
    value: fromValue,
    context: current.context,
  });
  const actor = createActor(trackedMachine, {
    input: current.context,
    snapshot,
  });
  actor.start();

  try {
    actor.send(event);
    const afterSnapshot = actor.getSnapshot();
    const nextValue =
      typeof afterSnapshot.value === "string"
        ? afterSnapshot.value
        : String(afterSnapshot.value);

    // 4. Validate — if state didn't change and no actions fired, it's invalid
    const stateChanged = nextValue !== fromValue;
    const hasActions = firedActions.length > 0;

    if (!stateChanged && !hasActions) {
      return {
        ok: false,
        error: `No valid transition from "${fromValue}" on event "${event.type}"`,
      };
    }

    // 5. Write new state to DB with optimistic lock (throws on conflict)
    if (stateChanged) {
      await writeState(entityId, nextValue, fromValue);
    }

    // 6. Execute real action handlers in the order they fired
    //    Use post-transition context so actions see updated state
    const actionContext = (afterSnapshot.context ?? current.context) as TContext;
    const failedActions: { action: string; error: unknown }[] = [];

    for (const actionName of firedActions) {
      const handler = actionHandlers[actionName];
      if (handler) {
        try {
          await handler(actionContext, event);
        } catch (err) {
          failedActions.push({ action: actionName, error: err });
          console.error(
            `[StateMachine] Action "${actionName}" failed for ${machine.id} ${entityId}:`,
            err,
          );
        }
      }
    }

    // 7. Log
    console.log(
      `[StateMachine] ${machine.id} ${entityId}: ${fromValue} → ${nextValue} (${event.type})`,
    );

    if (failedActions.length > 0) {
      console.warn(
        `[StateMachine] ${machine.id} ${entityId}: ${failedActions.length} action(s) failed: ${failedActions.map((f) => f.action).join(", ")}`,
      );
    }

    return {
      ok: true,
      from: fromValue,
      to: nextValue,
      event: event.type,
      failedActions: failedActions.length > 0
        ? failedActions.map((f) => f.action)
        : undefined,
    };
  } finally {
    // Always stop the actor to prevent memory leaks
    actor.stop();
  }
}
