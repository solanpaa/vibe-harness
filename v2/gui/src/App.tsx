import { useEffect } from "react";
import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { useDaemonStore } from "./stores/daemon";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { DaemonStatus } from "./components/shared/DaemonStatus";
import { Workspace } from "./pages/Workspace";
import { Projects } from "./pages/Projects";
import { Workflows } from "./pages/Workflows";
import { Credentials } from "./pages/Credentials";
import { Settings } from "./pages/Settings";

const NAV_ITEMS = [
  { to: "/", label: "Workspace" },
  { to: "/projects", label: "Projects" },
  { to: "/workflows", label: "Workflows" },
  { to: "/credentials", label: "Credentials" },
  { to: "/settings", label: "Settings" },
] as const;

function App() {
  const { setConnected, setDisconnected } = useDaemonStore();
  const navigate = useNavigate();

  // Listen for Tauri daemon events
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
