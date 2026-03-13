/** Shared types for the state machine module. */

// ---------------------------------------------------------------------------
// Transition result
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; from: string; to: string; event: string; failedActions?: string[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

export type ActionHandler<TContext = unknown, TEvent = unknown> = (
  context: TContext,
  event: TEvent
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export interface TaskContext {
  taskId: string;
  workflowRunId: string;
  originTaskId: string | null;
}

export type TaskEvent =
  | { type: "PROVISION" }
  | { type: "START"; sandboxId?: string }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "COMPLETE"; output?: string; lastAiMessage?: string | null; exitCode?: number }
  | { type: "FAIL"; output?: string; lastAiMessage?: string | null; exitCode?: number; error?: string }
  | { type: "CANCEL" };

export type TaskState =
  | "pending"
  | "provisioning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

// ---------------------------------------------------------------------------
// Workflow run types
// ---------------------------------------------------------------------------

export interface WorkflowRunContext {
  workflowRunId: string;
  workflowTemplateId: string;
  projectId: string;
  currentStage: string | null;
  currentStageName: string | null;
  currentTaskId: string | null;
  taskDescription: string | null;
  acpSessionId: string | null;
  autoAdvance: boolean;
  isLastStage: boolean;
  allChildrenDone: boolean;
}

export type WorkflowRunEvent =
  | { type: "START"; firstStageName?: string }
  | { type: "TASK_COMPLETED"; taskId?: string }
  | { type: "TASK_FAILED"; taskId?: string }
  | { type: "APPROVE"; reviewId?: string }
  | { type: "REQUEST_CHANGES"; reviewId?: string }
  | { type: "SPLIT"; reviewId?: string }
  | { type: "LAUNCH_PROPOSALS"; taskId?: string; proposalIds?: string[]; workflowTemplateId?: string; useFullWorkflow?: boolean }
  | { type: "CONSOLIDATE" }
  | { type: "FINALIZE" }
  | { type: "MERGE_CONFLICT" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "FAIL" }
  | { type: "CANCEL" };

export type WorkflowRunState =
  | "pending"
  | "running"
  | "paused"
  | "awaiting_review"
  | "awaiting_split_review"
  | "running_parallel"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";
