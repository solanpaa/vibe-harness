import type { WorkflowRunSummary } from "@vibe-harness/shared";
import { StatusBadge } from "../shared/StatusBadge";

interface RunCardProps {
  run: WorkflowRunSummary;
  isSelected: boolean;
  onClick: () => void;
}

export function RunCard({ run, isSelected, onClick }: RunCardProps) {
  const isLive = run.status === "running" || run.status === "provisioning";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg mb-1.5 transition-colors border ${
        isSelected
          ? "bg-blue-950/30 border-blue-500/40"
          : "bg-zinc-800/30 hover:bg-zinc-800/50 border-transparent"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-200 truncate">
            {run.title || run.description?.slice(0, 50) || run.id.slice(0, 8)}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-zinc-500 truncate">
              {run.projectName}
            </span>
            {run.currentStage && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="text-xs text-zinc-500">
                  {run.currentStage}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <StatusBadge status={run.status} size="sm" />
          <span className="text-[10px] text-zinc-600">
            {timeAgo(run.createdAt)}
          </span>
        </div>
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
