import type { StageExecutionDetail } from "@vibe-harness/shared";

interface StageTimelineProps {
  stages: StageExecutionDetail[];
  currentStage: string | null;
}

const STAGE_ICONS: Record<string, string> = {
  completed: "✓",
  running: "●",
  failed: "✕",
  pending: "○",
  skipped: "⊘",
};

const STAGE_COLORS: Record<string, string> = {
  completed: "text-green-400 border-green-500/50 bg-green-950/50",
  running: "text-blue-400 border-blue-500/50 bg-blue-950/50",
  failed: "text-red-400 border-red-500/50 bg-red-950/50",
  pending: "text-zinc-500 border-zinc-600/50 bg-zinc-800/50",
  skipped: "text-zinc-500 border-zinc-600/50 bg-zinc-800/30",
};

const CONNECTOR_COLORS: Record<string, string> = {
  completed: "bg-green-500/50",
  running: "bg-blue-500/50",
  failed: "bg-red-500/50",
  pending: "bg-zinc-600/30",
  skipped: "bg-zinc-600/30",
};

export function StageTimeline({ stages, currentStage }: StageTimelineProps) {
  if (stages.length === 0) {
    return (
      <div className="text-sm text-zinc-500 py-2">
        No stage information available
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0 overflow-x-auto py-3 px-1">
      {stages.map((stage, i) => {
        const status = stage.stageName === currentStage && stage.status === "pending"
          ? "running"
          : stage.status;
        const icon = STAGE_ICONS[status] ?? "○";
        const colors = STAGE_COLORS[status] ?? STAGE_COLORS.pending;
        const isLast = i === stages.length - 1;

        return (
          <div key={stage.id} className="flex items-center">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium ${colors}`}
              title={`${stage.stageName} (round ${stage.round}) — ${status}`}
            >
              <span className={status === "running" ? "animate-pulse" : ""}>
                {icon}
              </span>
              <span>{stage.stageName}</span>
              {stage.round > 1 && (
                <span className="text-[10px] opacity-70">R{stage.round}</span>
              )}
              {stage.model && (
                <span className="text-[10px] opacity-50">{stage.model}</span>
              )}
            </div>
            {!isLast && (
              <div
                className={`w-6 h-0.5 ${CONNECTOR_COLORS[status] ?? CONNECTOR_COLORS.pending}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
