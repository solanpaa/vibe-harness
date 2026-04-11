import { useEffect, useCallback, useState, useRef } from "react";
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
  const { setRuns, selectedRunId, selectRun, setLoading, newRunModalOpen, setNewRunModalOpen } =
    useWorkspaceStore();

  const [leftWidth, setLeftWidth] = useState(340);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const ws = useWsRef();

  // Fetch runs on mount and when connection changes
  useEffect(() => {
    if (!client || !connected) return;

    let cancelled = false;
    setLoading(true);

    const fetchRuns = () => {
      client
        .listRuns()
        .then((res) => {
          if (!cancelled) setRuns(res.runs);
        })
        .catch((err) => console.error("Failed to load runs:", err))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchRuns();

    // Poll every 3s to catch status changes
    const interval = setInterval(fetchRuns, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, connected, setRuns, setLoading]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.max(200, Math.min(600, e.clientX - rect.left));
      setLeftWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleSelectRun = useCallback(
    (runId: string) => {
      selectRun(runId);
    },
    [selectRun],
  );

  const handleNewRunCreated = useCallback(
    (runId: string) => {
      setNewRunModalOpen(false);
      selectRun(runId);
      // Refresh the run list
      if (client) {
        client
          .listRuns()
          .then((res) => setRuns(res.runs))
          .catch((err) => console.error("Failed to refresh runs:", err));
      }
    },
    [client, selectRun, setRuns, setNewRunModalOpen],
  );

  return (
    <div ref={containerRef} className="flex h-full">
      {/* Left panel: run feed */}
      <div style={{ width: leftWidth }} className="flex-shrink-0 border-r border-zinc-700/50 overflow-hidden">
        {!connected ? (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            Connect to daemon to see runs
          </div>
        ) : (
          <RunFeed
            selectedRunId={selectedRunId}
            onSelectRun={handleSelectRun}
            onNewRun={() => setNewRunModalOpen(true)}
          />
        )}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
      />

      {/* Right panel: run detail */}
      <div className="flex-1 overflow-hidden">
        {selectedRunId ? (
          <RunDetail runId={selectedRunId} ws={ws} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
            <div className="text-4xl opacity-30">📋</div>
            <p className="text-sm">Select a run to view details</p>
            {connected && (
              <button
                onClick={() => setNewRunModalOpen(true)}
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
        open={newRunModalOpen}
        onClose={() => setNewRunModalOpen(false)}
        onCreated={handleNewRunCreated}
      />
    </div>
  );
}
