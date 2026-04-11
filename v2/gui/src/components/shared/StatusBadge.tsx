import type { WorkflowRunStatus, StageStatus, ReviewStatus } from "@vibe-harness/shared";

type AnyStatus = WorkflowRunStatus | StageStatus | ReviewStatus | string;

interface StatusBadgeProps {
  status: AnyStatus;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

const STATUS_CONFIG: Record<
  string,
  { bg: string; text: string; dot: string; label: string }
> = {
  // WorkflowRunStatus
  pending:        { bg: "bg-zinc-800",      text: "text-zinc-400",   dot: "bg-zinc-400",   label: "Pending" },
  provisioning:   { bg: "bg-blue-950",      text: "text-blue-400",   dot: "bg-blue-400",   label: "Provisioning" },
  running:        { bg: "bg-green-950",     text: "text-green-400",  dot: "bg-green-400",  label: "Running" },
  stage_failed:   { bg: "bg-red-950",       text: "text-red-400",    dot: "bg-red-400",    label: "Stage Failed" },
  awaiting_review:{ bg: "bg-yellow-950",    text: "text-yellow-400", dot: "bg-yellow-400", label: "Awaiting Review" },
  awaiting_proposals: { bg: "bg-purple-950", text: "text-purple-400", dot: "bg-purple-400", label: "Awaiting Proposals" },
  waiting_for_children: { bg: "bg-indigo-950", text: "text-indigo-400", dot: "bg-indigo-400", label: "Waiting" },
  children_completed_with_failures: { bg: "bg-orange-950", text: "text-orange-400", dot: "bg-orange-400", label: "Partial Fail" },
  awaiting_conflict_resolution: { bg: "bg-amber-950", text: "text-amber-400", dot: "bg-amber-400", label: "Conflict" },
  finalizing:     { bg: "bg-cyan-950",      text: "text-cyan-400",   dot: "bg-cyan-400",   label: "Finalizing" },
  completed:      { bg: "bg-green-950",     text: "text-green-400",  dot: "bg-green-400",  label: "Completed" },
  failed:         { bg: "bg-red-950",       text: "text-red-400",    dot: "bg-red-400",    label: "Failed" },
  cancelled:      { bg: "bg-zinc-800",      text: "text-zinc-500",   dot: "bg-zinc-500",   label: "Cancelled" },
  // StageStatus
  skipped:        { bg: "bg-zinc-800",      text: "text-zinc-500",   dot: "bg-zinc-500",   label: "Skipped" },
  // ReviewStatus
  pending_review: { bg: "bg-yellow-950",    text: "text-yellow-400", dot: "bg-yellow-400", label: "Pending Review" },
  approved:       { bg: "bg-green-950",     text: "text-green-400",  dot: "bg-green-400",  label: "Approved" },
  changes_requested: { bg: "bg-orange-950", text: "text-orange-400", dot: "bg-orange-400", label: "Changes Requested" },
};

const ANIMATED_STATUSES = new Set([
  "running", "provisioning", "finalizing", "waiting_for_children", "consolidating",
]);

const SIZE_MAP = {
  sm: { badge: "px-1.5 py-0.5 text-[10px]", dot: "h-1.5 w-1.5" },
  md: { badge: "px-2 py-0.5 text-xs", dot: "h-2 w-2" },
  lg: { badge: "px-2.5 py-1 text-sm", dot: "h-2.5 w-2.5" },
};

export function StatusBadge({ status, size = "md", showLabel = true }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    bg: "bg-zinc-800", text: "text-zinc-400", dot: "bg-zinc-400", label: status,
  };
  const s = SIZE_MAP[size];
  const animated = ANIMATED_STATUSES.has(status);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${config.bg} ${config.text} ${s.badge}`}
    >
      <span
        className={`inline-block rounded-full ${config.dot} ${s.dot} ${animated ? "animate-pulse" : ""}`}
      />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}
