import { setup } from "xstate";
import type { WorkflowRunContext, WorkflowRunEvent } from "../types";

/**
 * Workflow Run state machine — the central orchestrator.
 *
 * 10 states, 30 transitions. Handles sequential stages, reviews, reruns,
 * splits, and parallel execution. Review and parallel group status updates
 * are side effects of transitions (no separate state machines).
 */
export const workflowRunMachine = setup({
  types: {
    context: {} as WorkflowRunContext,
    events: {} as WorkflowRunEvent,
    input: {} as WorkflowRunContext,
  },
  guards: {
    isSplitStage: ({ context }) => context.currentStageName === "split",
    isAutoAdvance: ({ context }) => context.autoAdvance === true,
    isLastStage: ({ context }) => context.isLastStage === true,
    allChildrenDone: ({ context }) => context.allChildrenDone === true,
  },
  actions: {
    setCurrentStage: () => {},
    setCompletedAt: () => {},
    createReview: () => {},
    createMergeConflictReview: () => {},
    createConsolidationReview: () => {},
    setReviewApproved: () => {},
    setReviewChangesRequested: () => {},
    advanceToNextStage: () => {},
    launchNextStageTask: () => {},
    launchSplitTask: () => {},
    spawnRerunTask: () => {},
    rerunSplitStage: () => {},
    createParallelGroup: () => {},
    launchChildWorkflows: () => {},
    setParallelGroupCompleted: () => {},
    setParallelGroupFailed: () => {},
    pauseCurrentTask: () => {},
    resumeCurrentTask: () => {},
    cancelCurrentTask: () => {},
    cancelChildWorkflows: () => {},
    cleanupSandboxes: () => {},
  },
}).createMachine({
  id: "workflowRun",
  initial: "pending",
  context: ({ input }) => ({ ...input }),
  states: {
    // ----- Startup -----
    pending: {
      on: {
        START: { target: "running", actions: ["setCurrentStage"] },
      },
    },

    // ----- Running (task executing) -----
    running: {
      on: {
        TASK_COMPLETED: [
          {
            guard: "isSplitStage",
            target: "awaiting_split_review",
          },
          {
            guard: "isAutoAdvance",
            target: "running",
            actions: ["advanceToNextStage"],
          },
          {
            target: "awaiting_review",
            actions: ["createReview"],
          },
        ],
        TASK_FAILED: { target: "failed", actions: ["setCompletedAt"] },
        PAUSE: { target: "paused", actions: ["pauseCurrentTask"] },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: {
          target: "cancelled",
          actions: ["cancelCurrentTask", "setCompletedAt"],
        },
      },
    },

    // ----- Paused -----
    paused: {
      on: {
        // Race condition: task may complete while workflow is paused
        TASK_COMPLETED: [
          {
            guard: "isSplitStage",
            target: "awaiting_split_review",
          },
          {
            guard: "isAutoAdvance",
            target: "running",
            actions: ["advanceToNextStage"],
          },
          {
            target: "awaiting_review",
            actions: ["createReview"],
          },
        ],
        TASK_FAILED: { target: "failed", actions: ["setCompletedAt"] },
        RESUME: { target: "running", actions: ["resumeCurrentTask"] },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },

    // ----- Awaiting review -----
    awaiting_review: {
      on: {
        APPROVE: [
          {
            guard: "isLastStage",
            target: "finalizing",
            actions: ["setReviewApproved", "setCurrentStage"],
          },
          {
            target: "running",
            actions: [
              "setReviewApproved",
              "setCurrentStage",
              "launchNextStageTask",
            ],
          },
        ],
        REQUEST_CHANGES: {
          target: "running",
          actions: ["setReviewChangesRequested", "spawnRerunTask"],
        },
        SPLIT: {
          target: "running",
          actions: [
            "setReviewApproved",
            "setCurrentStage",
            "launchSplitTask",
          ],
        },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },

    // ----- Awaiting split review (proposals) -----
    awaiting_split_review: {
      on: {
        LAUNCH_PROPOSALS: {
          target: "running_parallel",
          actions: ["createParallelGroup", "launchChildWorkflows"],
        },
        REQUEST_CHANGES: {
          target: "running",
          actions: ["rerunSplitStage"],
        },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },

    // ----- Running parallel (children executing) -----
    running_parallel: {
      on: {
        CONSOLIDATE: {
          guard: "allChildrenDone",
          target: "awaiting_review",
          actions: ["setParallelGroupCompleted", "createConsolidationReview"],
        },
        MERGE_CONFLICT: {
          target: "awaiting_review",
          actions: ["createMergeConflictReview"],
        },
        FAIL: {
          target: "failed",
          actions: ["setParallelGroupFailed", "setCompletedAt"],
        },
        CANCEL: {
          target: "cancelled",
          actions: ["cancelChildWorkflows", "setCompletedAt"],
        },
      },
    },

    // ----- Finalizing (merging) -----
    finalizing: {
      on: {
        FINALIZE: { target: "completed", actions: ["setCompletedAt"] },
        MERGE_CONFLICT: {
          target: "awaiting_review",
          actions: ["createMergeConflictReview"],
        },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },

    // ----- Terminal states -----
    completed: { type: "final", entry: ["cleanupSandboxes"] },
    failed: { type: "final", entry: ["cleanupSandboxes"] },
    cancelled: { type: "final", entry: ["cleanupSandboxes"] },
  },
});
