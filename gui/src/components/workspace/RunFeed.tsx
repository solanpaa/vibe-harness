import { useMemo, useCallback } from "react";
import type { WorkflowRunStatus, WorkflowRunSummary } from "@vibe-harness/shared";
import { useWorkspaceStore } from "../../stores/workspace";
import { useDaemonStore } from "../../stores/daemon";
import { RunCard } from "./RunCard";

interface RunFeedProps {
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onNewRun: () => void;
}

const STATUS_FILTERS: { label: string; value: WorkflowRunStatus | null }[] = [
  { label: "All", value: null },
  { label: "Running", value: "running" },
  { label: "Review", value: "awaiting_review" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
];

export function RunFeed({ selectedRunId, onSelectRun, onNewRun }: RunFeedProps) {
  const runs = useWorkspaceStore((s) => s.runs);
  const statusFilter = useWorkspaceStore((s) => s.statusFilter);
  const setStatusFilter = useWorkspaceStore((s) => s.setStatusFilter);
  const loading = useWorkspaceStore((s) => s.loading);
  const removeRun = useWorkspaceStore((s) => s.removeRun);
  const { client } = useDaemonStore();

  const handleDelete = useCallback(
    async (runId: string) => {
      if (!client) return;
      try {
        await client.deleteRun(runId);
        removeRun(runId);
      } catch (err) {
        console.error("Failed to delete run:", err);
      }
    },
    [client, removeRun],
  );

  const filteredRuns = useMemo(() => {
    let result: WorkflowRunSummary[] = runs;
    if (statusFilter) {
      result = result.filter((r) => r.status === statusFilter);
    }
    // Sort by most recent first
    return [...result].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [runs, statusFilter]);

  return (
    <div className="flex flex-col h-full p-3">
      {/* Header: title + new run button */}
      <div className="flex items-center justify-between mb-3 px-3 pt-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
          Runs
        </h2>
        <button
          onClick={onNewRun}
          className="w-6 h-6 flex items-center justify-center rounded text-zinc-400 hover:text-foreground hover:bg-accent transition-colors"
          title="New run"
        >
          +
        </button>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setStatusFilter(f.value)}
            className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
              statusFilter === f.value
                ? "bg-zinc-600 text-zinc-100"
                : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="text-sm text-zinc-500 py-4 text-center">Loading...</p>
        )}
        {!loading && filteredRuns.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-zinc-500">
              {statusFilter ? "No runs with this status" : "No runs yet"}
            </p>
            <button
              onClick={onNewRun}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300"
            >
              Create your first run →
            </button>
          </div>
        )}
        {filteredRuns.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            isSelected={selectedRunId === run.id}
            onClick={() => onSelectRun(run.id)}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
