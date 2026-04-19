import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import { StatusBadge } from "../shared/StatusBadge";
import type {
  ParallelGroupDetailResponse,
  WorkflowRun,
} from "@vibe-harness/shared";

interface ParallelGroupStatusProps {
  parallelGroupId: string;
  onSelectChild: (runId: string) => void;
  onStatusChange: () => void;
}

const CHILD_STATUS_ORDER: Record<string, number> = {
  running: 0,
  provisioning: 1,
  pending: 2,
  failed: 3,
  stage_failed: 4,
  completed: 5,
  cancelled: 6,
};

function childSortKey(run: WorkflowRun): number {
  return CHILD_STATUS_ORDER[run.status] ?? 99;
}

export function ParallelGroupStatus({
  parallelGroupId,
  onSelectChild,
  onStatusChange,
}: ParallelGroupStatusProps) {
  const { client } = useDaemonStore();

  const [detail, setDetail] = useState<ParallelGroupDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!client) return;
    try {
      const res = await client.getParallelGroup(parallelGroupId);
      setDetail(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load group");
    }
  }, [client, parallelGroupId]);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchDetail().finally(() => setLoading(false));
  }, [fetchDetail]);

  // Poll while group is active
  useEffect(() => {
    if (!detail) return;
    const activeStatuses = new Set(["pending", "running"]);
    if (!activeStatuses.has(detail.group.status)) return;

    const interval = setInterval(fetchDetail, 5000);
    return () => clearInterval(interval);
  }, [detail?.group.status, fetchDetail]);

  const handleConsolidate = useCallback(async () => {
    if (!client || actionLoading) return;
    setActionLoading("consolidate");
    setActionError(null);
    try {
      await client.consolidateGroup(parallelGroupId);
      await fetchDetail();
      onStatusChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to consolidate");
    } finally {
      setActionLoading(null);
    }
  }, [client, parallelGroupId, actionLoading, fetchDetail, onStatusChange]);

  const handleConsolidatePartial = useCallback(async () => {
    if (!client || actionLoading) return;
    setActionLoading("consolidate-partial");
    setActionError(null);
    try {
      await client.consolidateGroupPartial(parallelGroupId);
      await fetchDetail();
      onStatusChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to consolidate");
    } finally {
      setActionLoading(null);
    }
  }, [client, parallelGroupId, actionLoading, fetchDetail, onStatusChange]);

  const handleRetryFailed = useCallback(async () => {
    if (!client || actionLoading) return;
    setActionLoading("retry");
    setActionError(null);
    try {
      await client.retryFailedChildren(parallelGroupId);
      await fetchDetail();
      onStatusChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to retry");
    } finally {
      setActionLoading(null);
    }
  }, [client, parallelGroupId, actionLoading, fetchDetail, onStatusChange]);

  const handleCancelAll = useCallback(async () => {
    if (!client || actionLoading) return;
    setActionLoading("cancel");
    setActionError(null);
    try {
      await client.cancelGroup(parallelGroupId);
      await fetchDetail();
      onStatusChange();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setActionLoading(null);
    }
  }, [client, parallelGroupId, actionLoading, fetchDetail, onStatusChange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading parallel group...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        {error ?? "No data"}
      </div>
    );
  }

  const { group, children, summary } = detail;
  const finishedCount = summary.completed + summary.failed + summary.cancelled;
  const sortedChildren = [...children].sort((a, b) => childSortKey(a) - childSortKey(b));

  const groupStatus = group.status;
  const showConsolidate = groupStatus === "children_completed";
  const showMixedActions = groupStatus === "children_mixed";
  const isConsolidating = groupStatus === "consolidating";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header + progress */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-zinc-700/30 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-200">
              Parallel Execution
            </h3>
            <StatusBadge status={groupStatus} size="sm" />
          </div>
          <span className="text-xs text-zinc-500">
            {finishedCount} of {summary.total} completed
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full flex">
            {summary.completed > 0 && (
              <div
                className="bg-green-500 transition-all"
                style={{ width: `${(summary.completed / summary.total) * 100}%` }}
              />
            )}
            {summary.failed > 0 && (
              <div
                className="bg-red-500 transition-all"
                style={{ width: `${(summary.failed / summary.total) * 100}%` }}
              />
            )}
            {summary.cancelled > 0 && (
              <div
                className="bg-zinc-500 transition-all"
                style={{ width: `${(summary.cancelled / summary.total) * 100}%` }}
              />
            )}
            {summary.running > 0 && (
              <div
                className="bg-green-400 animate-pulse transition-all"
                style={{ width: `${(summary.running / summary.total) * 100}%` }}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-zinc-500">
          {summary.completed > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              {summary.completed} completed
            </span>
          )}
          {summary.running > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              {summary.running} running
            </span>
          )}
          {summary.pending > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-zinc-400" />
              {summary.pending} pending
            </span>
          )}
          {summary.failed > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              {summary.failed} failed
            </span>
          )}
          {summary.cancelled > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-zinc-500" />
              {summary.cancelled} cancelled
            </span>
          )}
        </div>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="flex-shrink-0 px-4 py-2 text-sm bg-red-950/30 text-red-300 border-b border-red-500/20">
          {actionError}
          <button
            onClick={() => setActionError(null)}
            className="ml-2 text-red-400 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}

      {/* Child run cards */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {sortedChildren.map((child) => (
            <button
              key={child.id}
              onClick={() => onSelectChild(child.id)}
              className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-zinc-700/30 bg-zinc-800/30 hover:bg-zinc-700/30 hover:border-zinc-600 transition-colors text-left"
            >
              <StatusBadge status={child.status} size="sm" />
              <span className="text-xs text-zinc-300 text-center truncate w-full">
                {child.title ?? child.description?.slice(0, 40) ?? child.id.slice(0, 8)}
              </span>
              {child.currentStage && (
                <span className="text-[10px] text-zinc-500">
                  Stage: {child.currentStage}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Actions toolbar */}
      {(showConsolidate || showMixedActions || isConsolidating) && (
        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700/30 bg-zinc-900/50">
          {isConsolidating && (
            <span className="text-xs text-purple-400 animate-pulse mr-auto">
              Consolidating results...
            </span>
          )}

          {showConsolidate && (
            <button
              onClick={handleConsolidate}
              disabled={!!actionLoading}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-700 text-white hover:bg-green-600 disabled:opacity-40 transition-colors"
            >
              {actionLoading === "consolidate" ? "Consolidating..." : "Consolidate"}
            </button>
          )}

          {showMixedActions && (
            <>
              <button
                onClick={handleConsolidatePartial}
                disabled={!!actionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-700 text-white hover:bg-green-600 disabled:opacity-40 transition-colors"
              >
                {actionLoading === "consolidate-partial"
                  ? "Consolidating..."
                  : "Consolidate Completed"}
              </button>
              <button
                onClick={handleRetryFailed}
                disabled={!!actionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-orange-700 text-white hover:bg-orange-600 disabled:opacity-40 transition-colors"
              >
                {actionLoading === "retry" ? "Retrying..." : "Retry Failed"}
              </button>
              <button
                onClick={handleCancelAll}
                disabled={!!actionLoading}
                className="px-3 py-1.5 text-xs rounded-md border border-red-500/30 text-red-400 hover:bg-red-950/50 disabled:opacity-40 transition-colors"
              >
                {actionLoading === "cancel" ? "Cancelling..." : "Cancel All"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
