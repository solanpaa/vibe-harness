import {
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  GitPullRequestArrow,
  Pause,
  GitFork,
  Merge,
  Ban,
  Play,
} from "lucide-react";
import type { TaskStatus, WorkflowRunStatus } from "@/types/domain";

// ─── Status helper functions ─────────────────────────────────────────────────

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["running", "provisioning"]);

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_WORKFLOW_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "running", "running_parallel", "finalizing",
]);

export function isTerminalTask(s: string): boolean {
  return TERMINAL_TASK_STATUSES.has(s as TaskStatus);
}

export function isActiveTask(s: string): boolean {
  return ACTIVE_TASK_STATUSES.has(s as TaskStatus);
}

export function shouldPollTask(s: string): boolean {
  return !TERMINAL_TASK_STATUSES.has(s as TaskStatus);
}

export function isTerminalWorkflow(s: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(s as WorkflowRunStatus);
}

export function isActiveWorkflow(s: string): boolean {
  return ACTIVE_WORKFLOW_STATUSES.has(s as WorkflowRunStatus);
}

export function shouldPollWorkflow(s: string): boolean {
  return !TERMINAL_WORKFLOW_STATUSES.has(s as WorkflowRunStatus);
}

export function isReviewPending(s: string): boolean {
  return s === "pending_review";
}

export function isReviewActionable(s: string): boolean {
  return s === "pending_review";
}

// ─── Dot color classes (for compact status indicators) ───────────────────────

export const statusDotClass: Record<string, string> = {
  provisioning: "bg-purple-500",
  pending: "bg-gray-500",
  running: "bg-blue-500",
  awaiting_review: "bg-yellow-500",
  awaiting_split_review: "bg-indigo-500",
  running_parallel: "bg-teal-500",
  finalizing: "bg-cyan-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
  paused: "bg-orange-500",
  cancelled: "bg-slate-500",
  // review statuses
  pending_review: "bg-yellow-500",
  changes_requested: "bg-orange-500",
  approved: "bg-green-500",
};

// ─── Task status ─────────────────────────────────────────────────────────────

export interface TaskStatusConfig {
  icon: React.ReactNode;
  colorClass: string;
  label: string;
}

export const taskStatusConfig: Record<string, TaskStatusConfig> = {
  provisioning: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    colorClass:
      "bg-purple-100 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
    label: "Provisioning",
  },
  pending: {
    icon: <Clock className="h-4 w-4" />,
    colorClass:
      "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
    label: "Pending",
  },
  running: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    colorClass:
      "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
    label: "Running",
  },
  awaiting_review: {
    icon: <GitPullRequestArrow className="h-4 w-4" />,
    colorClass:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
    label: "Awaiting Review",
  },
  completed: {
    icon: <CheckCircle className="h-4 w-4" />,
    colorClass:
      "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
    label: "Completed",
  },
  failed: {
    icon: <XCircle className="h-4 w-4" />,
    colorClass:
      "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
    label: "Failed",
  },
  paused: {
    icon: <Pause className="h-4 w-4" />,
    colorClass:
      "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
    label: "Paused",
  },
  cancelled: {
    icon: <Ban className="h-4 w-4" />,
    colorClass:
      "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
    label: "Cancelled",
  },
};

// ─── Workflow run status (superset of task status) ───────────────────────────

export const workflowStatusConfig: Record<string, TaskStatusConfig> = {
  ...taskStatusConfig,
  awaiting_split_review: {
    icon: <GitFork className="h-4 w-4" />,
    colorClass:
      "bg-indigo-100 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200",
    label: "Review Proposals",
  },
  running_parallel: {
    icon: <Play className="h-4 w-4" />,
    colorClass:
      "bg-teal-100 text-teal-800 dark:bg-teal-800 dark:text-teal-200",
    label: "Running Parallel",
  },
  finalizing: {
    icon: <Merge className="h-4 w-4 animate-spin" />,
    colorClass:
      "bg-cyan-100 text-cyan-800 dark:bg-cyan-800 dark:text-cyan-200",
    label: "Finalizing",
  },
};

// ─── Task feed icons (smaller, used in feed items) ───────────────────────────

export const taskFeedIcon: Record<string, React.ReactNode> = {
  provisioning: <Loader2 className="size-3.5 animate-spin text-purple-500" />,
  pending: <Clock className="size-3.5 text-muted-foreground/50" />,
  running: <Loader2 className="size-3.5 animate-spin text-blue-500" />,
  awaiting_review: (
    <GitPullRequestArrow className="size-3.5 text-yellow-500" />
  ),
  awaiting_split_review: <GitFork className="size-3.5 text-indigo-500" />,
  running_parallel: <Play className="size-3.5 text-teal-500" />,
  finalizing: <Merge className="size-3.5 animate-spin text-cyan-500" />,
  completed: <CheckCircle className="size-3.5 text-muted-foreground/40" />,
  failed: <XCircle className="size-3.5 text-red-500" />,
  paused: <Pause className="size-3.5 text-orange-500" />,
  cancelled: <Ban className="size-3.5 text-slate-500" />,
};

// ─── Task / workflow badge color classes ──────────────────────────────────────

export const taskBadgeClass: Record<string, string> = {
  provisioning:
    "bg-purple-100 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  pending:
    "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
  running:
    "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  awaiting_review:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  awaiting_split_review:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200",
  running_parallel:
    "bg-teal-100 text-teal-800 dark:bg-teal-800 dark:text-teal-200",
  finalizing:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-800 dark:text-cyan-200",
  completed:
    "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  failed:
    "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  paused:
    "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
  cancelled:
    "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
};

// ─── Review status ───────────────────────────────────────────────────────────

export interface ReviewStatusConfig {
  colorClass: string;
  label: string;
}

export const reviewStatusConfig: Record<string, ReviewStatusConfig> = {
  pending_review: {
    colorClass:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    label: "Pending Review",
  },
  changes_requested: {
    colorClass:
      "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    label: "Changes Requested",
  },
  approved: {
    colorClass:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    label: "Approved",
  },
};
