"use client";

import { useEffect, useState } from "react";
import { Loader2, GitPullRequestArrow } from "lucide-react";

interface Stats {
  activeTaskCount: number;
  pendingReviewCount: number;
}

export function StatusBar() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        if (res.ok) {
          const data = await res.json();
          setStats({
            activeTaskCount: data.activeTaskCount ?? 0,
            pendingReviewCount: data.pendingReviewCount ?? 0,
          });
          setConnected(true);
        } else {
          setConnected(false);
        }
      } catch {
        setConnected(false);
      }
    }

    fetchStats();
    const interval = setInterval(fetchStats, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t bg-card px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        {stats && stats.activeTaskCount > 0 && (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {stats.activeTaskCount} running
          </span>
        )}
        {stats && stats.pendingReviewCount > 0 && (
          <span className="flex items-center gap-1">
            <GitPullRequestArrow className="h-3 w-3" />
            {stats.pendingReviewCount} pending review{stats.pendingReviewCount !== 1 ? "s" : ""}
          </span>
        )}
        {stats && stats.activeTaskCount === 0 && stats.pendingReviewCount === 0 && (
          <span>No active tasks</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
        <span>{connected ? "Connected" : "Disconnected"}</span>
      </div>
    </div>
  );
}
