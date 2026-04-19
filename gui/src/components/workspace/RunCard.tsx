import type { WorkflowRunSummary } from "@vibe-harness/shared";
import { StatusBadge } from "../shared/StatusBadge";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";

const DELETABLE_STATUSES = ["completed", "failed", "cancelled", "stage_failed", "children_completed_with_failures"];

interface RunCardProps {
  run: WorkflowRunSummary;
  isSelected: boolean;
  onClick: () => void;
  onDelete?: (runId: string) => void;
}

export function RunCard({ run, isSelected, onClick, onDelete }: RunCardProps) {
  const isLive = run.status === "running" || run.status === "provisioning";
  const canDelete = DELETABLE_STATUSES.includes(run.status);

  const card = (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-md mb-1 transition-colors border ${
        isSelected
          ? "bg-blue-950/30 border-blue-500/40"
          : "bg-transparent hover:bg-zinc-800/40 border-transparent"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-200 truncate leading-tight">
            {run.title || run.description?.slice(0, 60) || run.id.slice(0, 8)}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {run.currentStage && (
              <span className="text-[11px] text-zinc-500">
                {run.currentStage}
              </span>
            )}
            <span className="text-[10px] text-zinc-600">
              {timeAgo(run.createdAt)}
            </span>
          </div>
        </div>
        <StatusBadge status={run.status} size="sm" />
      </div>

      {/* Streaming activity indicator */}
      {isLive && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[10px] text-green-400/70">Live</span>
        </div>
      )}
    </button>
  );

  if (!onDelete) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        {card}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          variant="destructive"
          disabled={!canDelete}
          onClick={() => onDelete(run.id)}
        >
          Delete run
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function timeAgo(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
