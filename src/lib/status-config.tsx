import {
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  GitPullRequestArrow,
  Pause,
} from "lucide-react";

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
};

// ─── Task feed icons (smaller, used in feed items) ───────────────────────────

export const taskFeedIcon: Record<string, React.ReactNode> = {
  provisioning: <Loader2 className="size-3.5 animate-spin text-purple-500" />,
  pending: <Clock className="size-3.5 text-muted-foreground/50" />,
  running: <Loader2 className="size-3.5 animate-spin text-blue-500" />,
  awaiting_review: (
    <GitPullRequestArrow className="size-3.5 text-yellow-500" />
  ),
  completed: <CheckCircle className="size-3.5 text-muted-foreground/40" />,
  failed: <XCircle className="size-3.5 text-red-500" />,
  paused: <Pause className="size-3.5 text-orange-500" />,
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
  completed:
    "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  failed:
    "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  paused:
    "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
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
