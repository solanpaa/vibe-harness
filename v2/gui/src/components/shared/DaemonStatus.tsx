import { useEffect, useRef } from "react";
import { useDaemonStore } from "../../stores/daemon";

const HEALTH_POLL_INTERVAL = 10_000;

export function DaemonStatus() {
  const { connected, port, lastError, lastHealthCheck, checkHealth } =
    useDaemonStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!connected) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial check
    checkHealth();

    intervalRef.current = setInterval(checkHealth, HEALTH_POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [connected, checkHealth]);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span
        className={`w-2 h-2 rounded-full ${
          connected
            ? "bg-green-500"
            : lastError
              ? "bg-red-500"
              : "bg-yellow-500 animate-pulse"
        }`}
      />
      <span className="text-zinc-400">
        {connected
          ? `Connected :${port}`
          : lastError
            ? "Disconnected"
            : "Connecting..."}
      </span>
      {connected && lastHealthCheck && (
        <span className="text-zinc-600">
          v{lastHealthCheck.version} · {Math.floor(lastHealthCheck.uptime)}s
        </span>
      )}
      {lastError && (
        <span className="text-red-400 truncate max-w-48" title={lastError}>
          {lastError}
        </span>
      )}
    </div>
  );
}
