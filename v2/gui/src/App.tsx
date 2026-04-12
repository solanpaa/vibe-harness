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
import { getAuthToken, getCachedToken } from "./api/client";

const NAV_ITEMS = [
  { to: "/", label: "Workspace" },
  { to: "/projects", label: "Projects" },
  { to: "/workflows", label: "Workflows" },
  { to: "/credentials", label: "Credentials" },
  { to: "/settings", label: "Settings" },
] as const;

/**
 * Shared hook: daemon connection + WS setup.
 * Used by both MainApp and pop-out windows.
 */
function useDaemonConnection() {
  const { setConnected, setDisconnected, port } = useDaemonStore();
  const { handleMessage, setWsState } = useStreamingStore();
  const wsRef = useRef<WebSocketManager | null>(null);

  useWebSocketBridge(wsRef.current);

  useEffect(() => {
    invoke<{ port: number } | null>("get_daemon_status")
      .then((result) => {
        if (result?.port) {
          setConnected(result.port);
        }
      })
      .catch(() => {});
  }, [setConnected]);

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

  useEffect(() => {
    if (!port) {
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      return;
    }

    const ws = new WebSocketManager({
      getUrl: () => `ws://127.0.0.1:${port}/ws`,
      // getAuthToken is called on each connect/reconnect — resetConnection()
      // clears the cache so this always returns the latest token.
      getAuthToken: () => {
        // Synchronous: returns cached or empty. The cache is populated
        // before first connect and cleared on reconnect via resetConnection().
        const cached = getCachedToken();
        return cached ?? '';
      },
    });

    ws.onMessage(handleMessage);
    ws.onStateChange(setWsState);

    // Pre-populate token cache, then connect
    getAuthToken().then(() => {
      ws.connect();
    });

    wsRef.current = ws;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__vibeWsRef = ws;

    return () => {
      ws.disconnect();
      wsRef.current = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__vibeWsRef = null;
    };
  }, [port, handleMessage, setWsState]);
}

/** Main application shell with sidebar nav. */
function MainApp() {
  const runs = useWorkspaceStore((s) => s.runs);
  const selectedRunId = useWorkspaceStore((s) => s.selectedRunId);
  const selectRun = useWorkspaceStore((s) => s.selectRun);
  const newRunModalOpen = useWorkspaceStore((s) => s.newRunModalOpen);
  const setNewRunModalOpen = useWorkspaceStore((s) => s.setNewRunModalOpen);
  const navigate = useNavigate();

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useDaemonConnection();

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
      {/* Top nav — sits in the titlebar overlay zone on macOS */}
      <nav
        data-tauri-drag-region
        className="flex items-end h-11 border-b border-zinc-700/50 bg-zinc-900 pl-[80px] pr-4"
      >
        <div className="flex items-end gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }: { isActive: boolean }) =>
                `px-3 pb-2 text-[13px] font-medium transition-colors border-b-2 ${
                  isActive
                    ? "border-blue-400 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 pb-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex items-center gap-2 px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-800/60 hover:bg-zinc-700/50 border border-zinc-700/60 rounded transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <span>Search</span>
            <kbd className="text-[10px] bg-zinc-700/50 px-1 py-0.5 rounded">⌘K</kbd>
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-end h-6 px-5 border-t border-zinc-800/80 bg-zinc-950/50 text-[11px] shrink-0">
        <DaemonStatus />
      </footer>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNewRun={handleNewRunFromPalette}
      />
    </div>
  );
}

/** Pop-out window shell — no sidebar, just the content with daemon connection (CDD-gui §9). */
function PopoutApp() {
  useDaemonConnection();

  return (
    <Routes>
      <Route path="/run/:runId" element={<PopoutRunDetail />} />
      <Route path="/run/:runId/review/:reviewId" element={<PopoutReviewPanel />} />
    </Routes>
  );
}

/**
 * Root App component.
 * Detects pop-out windows by route prefix and renders the appropriate shell.
 * Pop-out windows skip sidebar nav (SAD §2.2.2, CDD-gui §9).
 */
function App() {
  if (isPopoutWindow()) {
    return <PopoutApp />;
  }
  return <MainApp />;
}

export default App;
