import { createActor } from "xstate";
import { workflowRunMachine } from "../machines/workflow-run";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  workflowRunId: string;
  currentStageName: string | null;
  currentTaskId: string | null;
  autoAdvance: boolean;
  isLastStage: boolean;
  allChildrenDone: boolean;
}

const baseContext: TestContext = {
  workflowRunId: "wf-1",
  currentStageName: "implement",
  currentTaskId: "task-1",
  autoAdvance: false,
  isLastStage: false,
  allChildrenDone: false,
};

/** Start an actor with the given input overrides and immediately start it. */
function startActor(overrides: Partial<TestContext> = {}) {
  const actor = createActor(workflowRunMachine, {
    input: { ...baseContext, ...overrides },
  });
  actor.start();
  return actor;
}

/**
 * Create an actor at a specific state by using a modified machine.
 * We override the initial state to start at the desired state value.
 */
function transitionFrom(
  stateValue: string,
  event: { type: string; [k: string]: unknown },
  contextOverrides: Partial<TestContext> = {},
) {
  const ctx = { ...baseContext, ...contextOverrides };

  // Create a copy of the machine config with a different initial state
  const testMachine = workflowRunMachine.provide({});
  const actor = createActor(testMachine, { input: ctx, snapshot: testMachine.resolveState({ value: stateValue, context: ctx }) });
  actor.start();

  // Verify we're in the right state
  const before = actor.getSnapshot().value;

  // Send the event
  actor.send(event as any);
  const after = actor.getSnapshot().value;

  // Return an object with value and actions (approximate)
  return { value: after, changed: before !== after };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflowRunMachine", () => {
  // -----------------------------------------------------------------------
  // Happy path — single-stage workflow
  // -----------------------------------------------------------------------
  describe("happy path — single-stage workflow", () => {
    it("starts in pending and transitions to running on START", () => {
      const actor = startActor();
      expect(actor.getSnapshot().value).toBe("pending");

      actor.send({ type: "START" });
      expect(actor.getSnapshot().value).toBe("running");
    });

    it("running → TASK_COMPLETED (no guards) → awaiting_review", () => {
      const next = transitionFrom("running", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });
      expect(next.value).toBe("awaiting_review");
    });

    it("awaiting_review → APPROVE [isLastStage] → finalizing", () => {
      const next = transitionFrom(
        "awaiting_review",
        { type: "APPROVE" },
        { isLastStage: true },
      );
      expect(next.value).toBe("finalizing");
    });

    it("finalizing → FINALIZE → completed", () => {
      const next = transitionFrom("finalizing", { type: "FINALIZE" });
      expect(next.value).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // Happy path — multi-stage workflow
  // -----------------------------------------------------------------------
  describe("happy path — multi-stage workflow", () => {
    it("awaiting_review → APPROVE [isLastStage=false] → running", () => {
      const next = transitionFrom(
        "awaiting_review",
        { type: "APPROVE" },
        { isLastStage: false },
      );
      expect(next.value).toBe("running");
    });

    it("running → TASK_COMPLETED [isAutoAdvance] → running (self-transition)", () => {
      const next = transitionFrom(
        "running",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { autoAdvance: true },
      );
      expect(next.value).toBe("running");
    });
  });

  // -----------------------------------------------------------------------
  // Review decisions
  // -----------------------------------------------------------------------
  describe("review decisions", () => {
    it("awaiting_review → REQUEST_CHANGES → running", () => {
      const next = transitionFrom("awaiting_review", {
        type: "REQUEST_CHANGES",
      });
      expect(next.value).toBe("running");
    });

    it("awaiting_review → SPLIT → running", () => {
      const next = transitionFrom("awaiting_review", { type: "SPLIT" });
      expect(next.value).toBe("running");
    });
  });

  // -----------------------------------------------------------------------
  // Split → parallel flow
  // -----------------------------------------------------------------------
  describe("split → parallel flow", () => {
    it("running → TASK_COMPLETED [isSplitStage] → awaiting_split_review", () => {
      const next = transitionFrom(
        "running",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { currentStageName: "split" },
      );
      expect(next.value).toBe("awaiting_split_review");
    });

    it("awaiting_split_review → LAUNCH_PROPOSALS → running_parallel", () => {
      const next = transitionFrom("awaiting_split_review", {
        type: "LAUNCH_PROPOSALS",
      });
      expect(next.value).toBe("running_parallel");
    });

    it("running_parallel → CONSOLIDATE [allChildrenDone] → awaiting_review", () => {
      const next = transitionFrom(
        "running_parallel",
        { type: "CONSOLIDATE" },
        { allChildrenDone: true },
      );
      expect(next.value).toBe("awaiting_review");
    });

    it("awaiting_split_review → REQUEST_CHANGES → running", () => {
      const next = transitionFrom("awaiting_split_review", {
        type: "REQUEST_CHANGES",
      });
      expect(next.value).toBe("running");
    });
  });

  // -----------------------------------------------------------------------
  // Merge conflict recovery
  // -----------------------------------------------------------------------
  describe("merge conflict recovery", () => {
    it("finalizing → MERGE_CONFLICT → awaiting_review", () => {
      const next = transitionFrom("finalizing", { type: "MERGE_CONFLICT" });
      expect(next.value).toBe("awaiting_review");
    });

    it("full cycle: MERGE_CONFLICT → awaiting_review → APPROVE → finalizing → FINALIZE → completed", () => {
      const ctx = { isLastStage: true };

      const afterConflict = transitionFrom(
        "finalizing",
        { type: "MERGE_CONFLICT" },
        ctx,
      );
      expect(afterConflict.value).toBe("awaiting_review");

      const afterApprove = transitionFrom(
        "awaiting_review",
        { type: "APPROVE" },
        ctx,
      );
      expect(afterApprove.value).toBe("finalizing");

      const afterFinalize = transitionFrom(
        "finalizing",
        { type: "FINALIZE" },
        ctx,
      );
      expect(afterFinalize.value).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // Pause / Resume
  // -----------------------------------------------------------------------
  describe("pause / resume", () => {
    it("running → PAUSE → paused", () => {
      const next = transitionFrom("running", { type: "PAUSE" });
      expect(next.value).toBe("paused");
    });

    it("paused → RESUME → running", () => {
      const next = transitionFrom("paused", { type: "RESUME" });
      expect(next.value).toBe("running");
    });

    it("paused → TASK_COMPLETED → awaiting_review (race condition)", () => {
      const next = transitionFrom("paused", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });
      expect(next.value).toBe("awaiting_review");
    });

    it("paused → TASK_COMPLETED [isSplitStage] → awaiting_split_review (race)", () => {
      const next = transitionFrom(
        "paused",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { currentStageName: "split" },
      );
      expect(next.value).toBe("awaiting_split_review");
    });

    it("paused → TASK_COMPLETED [isAutoAdvance] → running (race)", () => {
      const next = transitionFrom(
        "paused",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { autoAdvance: true },
      );
      expect(next.value).toBe("running");
    });

    it("paused → TASK_FAILED → failed (race condition)", () => {
      const next = transitionFrom("paused", { type: "TASK_FAILED" });
      expect(next.value).toBe("failed");
    });
  });

  // -----------------------------------------------------------------------
  // Guard ordering for TASK_COMPLETED
  // -----------------------------------------------------------------------
  describe("guard ordering for TASK_COMPLETED", () => {
    it("isSplitStage takes priority over isAutoAdvance", () => {
      const next = transitionFrom(
        "running",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { currentStageName: "split", autoAdvance: true },
      );
      expect(next.value).toBe("awaiting_split_review");
    });

    it("isAutoAdvance takes priority over default", () => {
      const next = transitionFrom(
        "running",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { autoAdvance: true, currentStageName: "implement" },
      );
      expect(next.value).toBe("running");
    });

    it("neither guard → default → awaiting_review", () => {
      const next = transitionFrom(
        "running",
        { type: "TASK_COMPLETED", taskId: "task-1" },
        { autoAdvance: false, currentStageName: "implement" },
      );
      expect(next.value).toBe("awaiting_review");
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation from 5 states
  // -----------------------------------------------------------------------
  describe("cancellation", () => {
    const cancellableStates = [
      "running",
      "paused",
      "awaiting_review",
      "awaiting_split_review",
      "running_parallel",
      "finalizing",
    ] as const;

    for (const state of cancellableStates) {
      it(`${state} → CANCEL → cancelled`, () => {
        const next = transitionFrom(state, { type: "CANCEL" });
        expect(next.value).toBe("cancelled");
      });
    }
  });

  // -----------------------------------------------------------------------
  // Failure from 5 states
  // -----------------------------------------------------------------------
  describe("failure", () => {
    const failableStates = [
      "running",
      "paused",
      "finalizing",
      "running_parallel",
      "awaiting_split_review",
    ] as const;

    for (const state of failableStates) {
      it(`${state} → FAIL → failed`, () => {
        const next = transitionFrom(state, { type: "FAIL" });
        expect(next.value).toBe("failed");
      });
    }
  });

  // -----------------------------------------------------------------------
  // TASK_FAILED from running and paused
  // -----------------------------------------------------------------------
  describe("TASK_FAILED", () => {
    it("running → TASK_FAILED → failed", () => {
      const next = transitionFrom("running", { type: "TASK_FAILED" });
      expect(next.value).toBe("failed");
    });

    it("paused → TASK_FAILED → failed", () => {
      const next = transitionFrom("paused", { type: "TASK_FAILED" });
      expect(next.value).toBe("failed");
    });
  });

  // -----------------------------------------------------------------------
  // Negative guard cases
  // -----------------------------------------------------------------------
  describe("negative guard cases", () => {
    it("CONSOLIDATE rejected when allChildrenDone is false", () => {
      const next = transitionFrom(
        "running_parallel",
        { type: "CONSOLIDATE" },
        { allChildrenDone: false },
      );
      // Should stay in running_parallel — guard prevents transition
      expect(next.value).toBe("running_parallel");
    });
  });

  // -----------------------------------------------------------------------
  // running_parallel ignores task events (children are independent workflows)
  // -----------------------------------------------------------------------
  describe("running_parallel isolation", () => {
    it("running_parallel ignores TASK_COMPLETED (children are separate workflows)", () => {
      const next = transitionFrom("running_parallel", {
        type: "TASK_COMPLETED",
        taskId: "child-task-1",
      });
      expect(next.value).toBe("running_parallel");
    });

    it("running_parallel ignores TASK_FAILED", () => {
      const next = transitionFrom("running_parallel", {
        type: "TASK_FAILED",
        taskId: "child-task-1",
      });
      expect(next.value).toBe("running_parallel");
    });
  });

  // -----------------------------------------------------------------------
  // finalizing is cancellable
  // -----------------------------------------------------------------------
  describe("finalizing cancellation", () => {
    it("finalizing → CANCEL → cancelled", () => {
      const next = transitionFrom("finalizing", { type: "CANCEL" });
      expect(next.value).toBe("cancelled");
    });
  });

  // -----------------------------------------------------------------------
  // Invalid / rejected transitions
  // -----------------------------------------------------------------------
  describe("invalid transitions", () => {
    it("pending does not accept TASK_COMPLETED", () => {
      const actor = startActor();
      expect(actor.getSnapshot().value).toBe("pending");

      actor.send({ type: "TASK_COMPLETED", taskId: "task-1" });
      expect(actor.getSnapshot().value).toBe("pending");
    });

    it("awaiting_review does not accept TASK_COMPLETED", () => {
      const next = transitionFrom("awaiting_review", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });
      expect(next.value).toBe("awaiting_review");
    });

    it("completed is a terminal state — ignores START", () => {
      const next = transitionFrom("completed", { type: "START" });
      expect(next.value).toBe("completed");
    });

    it("failed is a terminal state — ignores RESUME", () => {
      const next = transitionFrom("failed", { type: "RESUME" });
      expect(next.value).toBe("failed");
    });

    it("cancelled is a terminal state — ignores START", () => {
      const next = transitionFrom("cancelled", { type: "START" });
      expect(next.value).toBe("cancelled");
    });
  });
});
