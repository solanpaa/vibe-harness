import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { StreamdownTest } from "./components/StreamdownTest";

type DaemonStatus =
  | { state: "connecting" }
  | { state: "connected"; port: number }
  | { state: "error"; message: string };

type HealthResponse = { status: string; pid?: number; uptime?: number };

function App() {
  const [status, setStatus] = useState<DaemonStatus>({ state: "connecting" });
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const unlisten = listen<{ port: number }>("daemon-connected", (event) => {
      setStatus({ state: "connected", port: event.payload.port });
    });

    const unlistenErr = listen<{ message: string }>("daemon-error", (event) => {
      setStatus({ state: "error", message: event.payload.message });
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenErr.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (status.state !== "connected") return;

    const fetchHealth = async () => {
      try {
        const res = await fetch(`http://localhost:${status.port}/health`);
        const data = await res.json();
        setHealth(data);
      } catch (err) {
        setHealth(null);
        console.error("Health check failed:", err);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <div className="container">
      <h1>Vibe Harness</h1>

      <div className="status-card">
        <h2>Daemon Status</h2>
        {status.state === "connecting" && (
          <div className="status connecting">
            <span className="dot pulse" />
            Connecting to daemon...
          </div>
        )}
        {status.state === "connected" && (
          <div className="status connected">
            <span className="dot" />
            Connected to daemon on port {status.port}
          </div>
        )}
        {status.state === "error" && (
          <div className="status error">
            <span className="dot" />
            Error: {status.message}
          </div>
        )}
      </div>

      {health && (
        <div className="status-card">
          <h2>Health Check</h2>
          <pre>{JSON.stringify(health, null, 2)}</pre>
        </div>
      )}

      <StreamdownTest />
    </div>
  );
}

export default App;
