import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import { useWorkspaceStore } from "../stores/workspace";
import { RunFeed } from "../components/workspace/RunFeed";
import { NewRunModal } from "../components/workspace/NewRunModal";
import { RunDetail } from "../components/run/RunDetail";
import type { WebSocketManager } from "../api/ws";

/**
 * Get the WebSocket manager from the App-level ref.
 * App.tsx stores it on window so child pages can access it without prop drilling.
 */
function useWsRef(): WebSocketManager | null {
  // The WS ref is stored on the window by App.tsx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__vibeWsRef ?? null;
}

export function Workspace() {
  const { client, connected } = useDaemonStore();
  const { setRuns, selectedRunId, selectRun, setLoading } =
    useWorkspaceStore();

  const [showNewRunModal, setShowNewRunModal] = useState(false);
  const ws = useWsRef();

  // Fetch runs on mount and when connection changes
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

  const handleSelectRun = useCallback(
    (runId: string) => {
      selectRun(runId);
    },
    [selectRun],
  );

  const handleNewRunCreated = useCallback(
    (runId: string) => {
      setShowNewRunModal(false);
      selectRun(runId);
      // Refresh the run list
      if (client) {
        client
          .listRuns()
          .then((res) => setRuns(res.runs))
          .catch((err) => console.error("Failed to refresh runs:", err));
      }
    },
    [client, selectRun, setRuns],
  );

  return (
    <div className="flex h-full gap-0">
      {/* Left panel: run feed (320px) */}
      <div className="w-80 flex-shrink-0 border-r border-zinc-700/50 pr-4 overflow-hidden">
        {!connected ? (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            Connect to daemon to see runs
          </div>
        ) : (
          <RunFeed
            selectedRunId={selectedRunId}
            onSelectRun={handleSelectRun}
            onNewRun={() => setShowNewRunModal(true)}
          />
        )}
      </div>

      {/* Right panel: run detail (flex-1) */}
      <div className="flex-1 overflow-hidden pl-4">
        {selectedRunId ? (
          <RunDetail runId={selectedRunId} ws={ws} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
            <div className="text-4xl opacity-30">📋</div>
            <p className="text-sm">Select a run to view details</p>
            {connected && (
              <button
                onClick={() => setShowNewRunModal(true)}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                or create a new run →
              </button>
            )}
          </div>
        )}
      </div>

      {/* New Run Modal */}
      <NewRunModal
        open={showNewRunModal}
        onClose={() => setShowNewRunModal(false)}
        onCreated={handleNewRunCreated}
      />
    </div>
  );
}
