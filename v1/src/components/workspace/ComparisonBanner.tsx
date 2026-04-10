"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  GitCompare,
  Trophy,
  Clock,
  FileCode,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { statusDotClass, isTerminalTask, isActiveTask } from "@/lib/status-config";
import { formatDuration } from "@/lib/format";

// ── Types ────────────────────────────────────────────────────────────

interface ComparisonTask {
  id: string;
  agentName: string;
  agentType: string;
  model: string | null;
  status: string;
  executionMode: string;
  duration: number | null;
  usageStats: {
    premiumRequests?: number;
    sessionDurationMs?: number;
  } | null;
  lastAiMessage: string | null;
  reviewId: string | null;
  reviewStatus: string | null;
  diffStats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  } | null;
}

interface ComparisonGroup {
  id: string;
  projectId: string;
  prompt: string;
  title: string | null;
  status: string;
  tasks: ComparisonTask[];
}

interface ComparisonBannerProps {
  comparisonGroupId: string;
  currentTaskId: string;
  onTaskChanged?: () => void;
}

// ── Component ────────────────────────────────────────────────────────

export function ComparisonBanner({
  comparisonGroupId,
  currentTaskId,
  onTaskChanged,
}: ComparisonBannerProps) {
  const [group, setGroup] = useState<ComparisonGroup | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);

  const fetchGroup = useCallback(() => {
    fetch(`/api/comparisons/${comparisonGroupId}`)
      .then((r) => r.json())
      .then((data) => setGroup(data))
      .catch(() => {});
  }, [comparisonGroupId]);

  useEffect(() => {
    fetchGroup();
    const interval = setInterval(fetchGroup, 5000);
    return () => clearInterval(interval);
  }, [fetchGroup]);

  if (!group) return null;

  const done = group.tasks.filter(
    (t) => isTerminalTask(t.status) || t.status === "awaiting_review"
  ).length;
  const total = group.tasks.length;
  const allDone = done === total;
  const isCompleted = group.status === "completed";

  async function handlePickWinner(taskId: string) {
    setPicking(true);
    try {
      const res = await fetch(`/api/comparisons/${comparisonGroupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pick_winner", winnerTaskId: taskId }),
      });
      if (res.ok) {
        const result = await res.json();
        toast.success(
          result.merged
            ? "Winner merged successfully!"
            : "Winner selected. Merge may need manual resolution."
        );
        fetchGroup();
        onTaskChanged?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Failed to pick winner");
      }
    } catch {
      toast.error("Failed to pick winner");
    } finally {
      setPicking(false);
    }
  }



  return (
    <div className="border-b bg-muted/30">
      {/* Compact header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <GitCompare className="h-4 w-4 text-purple-400 shrink-0" />
        <span className="text-[12px] font-medium text-purple-400">
          Comparison
        </span>
        <span className="text-[11px] text-muted-foreground">
          {group.title || "Agent comparison"} · {done}/{total} done
        </span>
        {isCompleted && (
          <Badge className="bg-green-900/40 text-green-300 text-[9px] px-1.5 py-0">
            Complete
          </Badge>
        )}
        <span className="ml-auto">
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Expanded comparison table */}
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-medium py-1">Agent / Model</th>
                <th className="text-left font-medium py-1">Status</th>
                <th className="text-right font-medium py-1">Files</th>
                <th className="text-right font-medium py-1">+/-</th>
                <th className="text-right font-medium py-1">Duration</th>
                {allDone && !isCompleted && (
                  <th className="text-right font-medium py-1">Action</th>
                )}
              </tr>
            </thead>
            <tbody>
              {group.tasks.map((task) => (
                <tr
                  key={task.id}
                  className={`border-t border-border/30 ${
                    task.id === currentTaskId
                      ? "bg-accent/50"
                      : ""
                  }`}
                >
                  <td className="py-1.5">
                    <span className="font-medium">
                      {task.agentName}
                    </span>
                    {task.model && (
                      <span className="text-muted-foreground ml-1">
                        ({task.model})
                      </span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <span className="flex items-center gap-1">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          statusDotClass[task.status] ?? "bg-gray-400"
                        }`}
                      />
                      {isActiveTask(task.status) && (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      )}
                      <span>{task.status.replace(/_/g, " ")}</span>
                    </span>
                  </td>
                  <td className="text-right py-1.5">
                    {task.diffStats ? (
                      <span className="flex items-center justify-end gap-0.5">
                        <FileCode className="h-3 w-3" />
                        {task.diffStats.filesChanged}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-right py-1.5">
                    {task.diffStats ? (
                      <span>
                        <span className="text-green-400">
                          +{task.diffStats.additions}
                        </span>
                        /
                        <span className="text-red-400">
                          -{task.diffStats.deletions}
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-right py-1.5">
                    {task.duration ? (
                      <span className="flex items-center justify-end gap-0.5">
                        <Clock className="h-3 w-3" />
                        {formatDuration(task.duration)}
                      </span>
                    ) : isActiveTask(task.status) ? (
                      "..."
                    ) : (
                      "—"
                    )}
                  </td>
                  {allDone && !isCompleted && (
                    <td className="text-right py-1.5">
                      {task.status !== "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2"
                          onClick={() => handlePickWinner(task.id)}
                          disabled={picking}
                        >
                          {picking ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Trophy className="mr-0.5 h-3 w-3 text-amber-400" />
                              Pick
                            </>
                          )}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {isCompleted && (
            <div className="text-[11px] text-green-400 flex items-center gap-1">
              <Trophy className="h-3 w-3" />
              Winner selected and merged
            </div>
          )}
        </div>
      )}
    </div>
  );
}
