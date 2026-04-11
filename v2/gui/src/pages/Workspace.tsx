import { useEffect } from "react";
import { useDaemonStore } from "../stores/daemon";
import { useWorkspaceStore } from "../stores/workspace";

export function Workspace() {
  const { client, connected } = useDaemonStore();
  const { runs, setRuns, selectedRunId, selectRun, loading, setLoading } =
    useWorkspaceStore();

  useEffect(() => {
    if (!client || !connected) return;

    let cancelled = false;
    setLoading(true);

    client
      .listRuns()
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch((err) => console.error("Failed to load runs:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, connected, setRuns, setLoading]);

  return (
    <div className="flex h-full gap-4">
      {/* Left panel: run list */}
      <div className="w-80 flex-shrink-0 border-r border-zinc-700 pr-4 overflow-y-auto">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">
          Runs
        </h2>
        {!connected && (
          <p className="text-sm text-zinc-500">
            Connect to daemon to see runs
          </p>
        )}
        {loading && (
          <p className="text-sm text-zinc-500">Loading...</p>
        )}
        {!loading && connected && runs.length === 0 && (
          <p className="text-sm text-zinc-500">No runs yet</p>
        )}
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => selectRun(run.id)}
            className={`w-full text-left p-3 rounded-lg mb-2 transition-colors ${
              selectedRunId === run.id
                ? "bg-blue-900/50 border border-blue-500/50"
                : "bg-zinc-800/50 hover:bg-zinc-700/50 border border-transparent"
            }`}
          >
            <div className="text-sm font-medium text-zinc-200 truncate">
              {run.title || run.description || run.id.slice(0, 8)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-zinc-500">{run.status}</span>
              <span className="text-xs text-zinc-600">
                {run.projectName}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Right panel: run detail */}
      <div className="flex-1 overflow-y-auto">
        {selectedRunId ? (
          <div>
            <h2 className="text-lg font-semibold text-zinc-200 mb-4">
              Run Detail
            </h2>
            <p className="text-sm text-zinc-400">
              Selected: {selectedRunId}
            </p>
            <p className="text-xs text-zinc-500 mt-2">
              Full run detail view coming soon
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500">
            Select a run to view details
          </div>
        )}
      </div>
    </div>
  );
}
