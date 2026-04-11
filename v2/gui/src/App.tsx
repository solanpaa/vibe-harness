import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useDaemonStore } from "./stores/daemon";
import { useStreamingStore } from "./stores/streaming";
import { useWorkspaceStore } from "./stores/workspace";
import { WebSocketManager } from "./api/ws";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWebSocketBridge } from "./hooks/useWebSocketBridge";
import { DaemonStatus } from "./components/shared/DaemonStatus";
import { CommandPalette } from "./components/shared/CommandPalette";
import { Workspace } from "./pages/Workspace";
import { Projects } from "./pages/Projects";
import { Workflows } from "./pages/Workflows";
import { Credentials } from "./pages/Credentials";
import { Settings } from "./pages/Settings";
import { PopoutRunDetail } from "./pages/PopoutRunDetail";
import { PopoutReviewPanel } from "./pages/PopoutReviewPanel";
import { isPopoutWindow } from "./lib/popout";
import { getAuthToken } from "./api/client";

const NAV_ITEMS = [
  { to: "/", label: "Workspace" },
  { to: "/projects", label: "Projects" },
  { to: "/workflows", label: "Workflows" },
  { to: "/credentials", label: "Credentials" },
  { to: "/settings", label: "Settings" },
] as const;

function App() {
  const { setConnected, setDisconnected, port } = useDaemonStore();
  const { handleMessage, setWsState } = useStreamingStore();
  const runs = useWorkspaceStore((s) => s.runs);
  const selectedRunId = useWorkspaceStore((s) => s.selectedRunId);
  const selectRun = useWorkspaceStore((s) => s.selectRun);
  const newRunModalOpen = useWorkspaceStore((s) => s.newRunModalOpen);
  const setNewRunModalOpen = useWorkspaceStore((s) => s.setNewRunModalOpen);
  const navigate = useNavigate();
  const wsRef = useRef<WebSocketManager | null>(null);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Bridge WS events (run_status, review_created, etc.) to workspace store
  useWebSocketBridge(wsRef.current);

  // On mount, query Rust for current daemon status (avoids startup race with events)
  useEffect(() => {
    invoke<{ port: number } | null>("get_daemon_status")
      .then((result) => {
        if (result?.port) {
          setConnected(result.port);
        }
      })
      .catch(() => {
        // Command not available or failed — rely on events instead
      });
  }, [setConnected]);

  // Listen for Tauri daemon events (handles subsequent status changes)
  useEffect(() => {
    const unlisten = listen<{ port: number }>("daemon-connected", (event) => {
      setConnected(event.payload.port);
    });

    const unlistenErr = listen<{ message: string }>("daemon-error", (event) => {
      setDisconnected(event.payload.message);
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenErr.then((fn) => fn());
    };
  }, [setConnected, setDisconnected]);

  // Initialize WebSocket when daemon is connected
  useEffect(() => {
    if (!port) {
      // Disconnect WS if daemon disconnects
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      return;
    }

    // Cache token for synchronous access in WS config
    let cachedToken = '';
    getAuthToken().then((t) => { cachedToken = t ?? ''; });

    const ws = new WebSocketManager({
      getUrl: () => `ws://127.0.0.1:${port}/ws`,
      getAuthToken: () => cachedToken,
    });

    ws.onMessage(handleMessage);
    ws.onStateChange(setWsState);

    // Connect once token is ready
    getAuthToken().then((token) => {
      cachedToken = token ?? '';
      ws.connect();
    });

    wsRef.current = ws;
    // Expose WS ref for child pages (e.g. Workspace → RunDetail streaming)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__vibeWsRef = ws;

    return () => {
      ws.disconnect();
      wsRef.current = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__vibeWsRef = null;
    };
  }, [port, handleMessage, setWsState]);

  // Global keyboard shortcuts
  const shortcuts = useMemo(() => ({
    "mod+k": () => setCommandPaletteOpen((v) => !v),
    "mod+n": () => { navigate("/"); setNewRunModalOpen(true); },
    "mod+1": () => navigate("/"),
    "mod+2": () => navigate("/projects"),
    "mod+3": () => navigate("/workflows"),
    "mod+4": () => navigate("/credentials"),
    "mod+5": () => navigate("/settings"),
    "j": () => {
      if (commandPaletteOpen) return;
      const idx = runs.findIndex((r) => r.id === selectedRunId);
      const next = runs[idx + 1];
      if (next) selectRun(next.id);
      else if (runs.length > 0 && !selectedRunId) selectRun(runs[0].id);
    },
    "k": () => {
      if (commandPaletteOpen) return;
      const idx = runs.findIndex((r) => r.id === selectedRunId);
      const prev = runs[idx - 1];
      if (prev) selectRun(prev.id);
    },
    "escape": () => {
      if (commandPaletteOpen) { setCommandPaletteOpen(false); return; }
      if (newRunModalOpen) { setNewRunModalOpen(false); return; }
      if (selectedRunId) selectRun(null);
    },
  }), [navigate, commandPaletteOpen, newRunModalOpen, runs, selectedRunId, selectRun, setNewRunModalOpen]);

  useKeyboardShortcuts(shortcuts);

  const handleNewRunFromPalette = useCallback(() => {
    navigate("/");
    setNewRunModalOpen(true);
  }, [navigate, setNewRunModalOpen]);

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100">
      {/* Top nav */}
      <nav className="flex items-center border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-1 px-4 py-2">
          <span className="text-sm font-bold text-blue-400 mr-4">
            Vibe Harness
          </span>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }: { isActive: boolean }) =>
                `px-3 py-1.5 text-sm rounded-md transition-colors ${
                  isActive
                    ? "bg-zinc-700/50 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 hover:bg-zinc-700/50 border border-zinc-700 rounded-md transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <span>Search</span>
            <kbd className="text-[10px] bg-zinc-700/50 px-1 py-0.5 rounded">⌘K</kbd>
          </button>
          <DaemonStatus />
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden p-4">
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNewRun={handleNewRunFromPalette}
      />
    </div>
  );
}

export default App;
