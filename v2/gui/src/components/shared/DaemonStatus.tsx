import { useEffect } from "react";
import { useDaemonStore } from "../../stores/daemon";

const HEALTH_POLL_INTERVAL = 10_000;

export function DaemonStatus() {
  const { connected, port, lastError, lastHealthCheck, checkHealth } =
    useDaemonStore();

  // Always poll, even when disconnected — allows UI to self-heal
  useEffect(() => {
    checkHealth();

    const interval = setInterval(checkHealth, HEALTH_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkHealth]);

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {connected && lastHealthCheck && (
        <span className="text-zinc-600">
          v{lastHealthCheck.version}
        </span>
      )}
      {connected && port && (
        <span className="text-zinc-500">:{port}</span>
      )}
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected
            ? "bg-green-500"
            : lastError
              ? "bg-red-500"
              : "bg-yellow-500 animate-pulse"
        }`}
      />
      <span className={connected ? "text-zinc-500" : "text-zinc-400"}>
        {connected
          ? "Connected"
          : lastError
            ? "Disconnected"
            : "Connecting…"}
      </span>
    </div>
  );
}
