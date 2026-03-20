import { setup } from "xstate";
import type { TaskContext, TaskEvent } from "../types";

/**
 * Task state machine — tracks the agent process lifecycle.
 *
 * 7 states, 12 transitions. All orchestration logic (reviews, advancing
 * stages, splits) lives in the Workflow Run machine. The task just reports
 * completion/failure upward via the notifyWorkflow action.
 */
export const taskMachine = setup({
  types: {
    context: {} as TaskContext,
    events: {} as TaskEvent,
    input: {} as TaskContext,
  },
  actions: {
    saveOutput: () => {},
    setCompletedAt: () => {},
    setSandboxId: () => {},
    notifyWorkflow: () => {},
  },
}).createMachine({
  id: "task",
  initial: "pending",
  context: ({ input }) => ({ ...input }),
  states: {
    pending: {
      on: {
        PROVISION: { target: "provisioning" },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },
    provisioning: {
      on: {
        START: { target: "running", actions: ["setSandboxId"] },
        FAIL: { target: "failed", actions: ["setCompletedAt"] },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },
    running: {
      on: {
        COMPLETE: {
          target: "completed",
          actions: ["saveOutput", "setCompletedAt", "notifyWorkflow"],
        },
        PAUSE: { target: "paused" },
        FAIL: {
          target: "failed",
          actions: ["saveOutput", "setCompletedAt", "notifyWorkflow"],
        },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },
    paused: {
      on: {
        RESUME: { target: "running" },
        CANCEL: { target: "cancelled", actions: ["setCompletedAt"] },
      },
    },
    completed: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
});
