import { useEffect, useRef } from "react";
import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useDaemonStore } from "./stores/daemon";
import { useStreamingStore } from "./stores/streaming";
import { WebSocketManager } from "./api/ws";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWebSocketBridge } from "./hooks/useWebSocketBridge";
import { DaemonStatus } from "./components/shared/DaemonStatus";
import { Workspace } from "./pages/Workspace";
import { Projects } from "./pages/Projects";
import { Workflows } from "./pages/Workflows";
import { Credentials } from "./pages/Credentials";
import { Settings } from "./pages/Settings";
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
  const navigate = useNavigate();
  const wsRef = useRef<WebSocketManager | null>(null);

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

    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, [port, handleMessage, setWsState]);

  // Global keyboard shortcuts
  useKeyboardShortcuts({
    "mod+1": () => navigate("/"),
    "mod+2": () => navigate("/projects"),
    "mod+3": () => navigate("/workflows"),
    "mod+4": () => navigate("/credentials"),
    "mod+5": () => navigate("/settings"),
  });

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
        <div className="ml-auto">
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
    </div>
  );
}

export default App;
