"use client";

import { Loader2, GitPullRequestArrow } from "lucide-react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

export function StatusBar() {
  const stats = useWorkspaceStore((s) => s.stats);
  const connected = useWorkspaceStore((s) => s.connected);

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t bg-card px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        {stats.activeTaskCount > 0 && (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {stats.activeTaskCount} running
          </span>
        )}
        {stats.pendingReviewCount > 0 && (
          <span className="flex items-center gap-1">
            <GitPullRequestArrow className="h-3 w-3" />
            {stats.pendingReviewCount} pending review{stats.pendingReviewCount !== 1 ? "s" : ""}
          </span>
        )}
        {stats.activeTaskCount === 0 && stats.pendingReviewCount === 0 && (
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
