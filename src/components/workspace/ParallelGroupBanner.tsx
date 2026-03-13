"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  GitFork,
  GitMerge,
  Loader2,
  CheckCircle,
} from "lucide-react";
import { toast } from "sonner";
import { taskFeedIcon, taskBadgeClass, statusDotClass, isTerminalTask } from "@/lib/status-config";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChildRun {
  id: string;
  title: string | null;
  status: string;
  currentStage: string | null;
  sourceProposalId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface ParallelGroupDetail {
  id: string;
  name: string | null;
  description: string | null;
  status: string;
  childRuns: ChildRun[];
  summary: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
  };
}

interface ParallelGroupBannerProps {
  groupId: string;
  onRunClick?: (runId: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ParallelGroupBanner({
  groupId,
  onRunClick,
}: ParallelGroupBannerProps) {
  const [group, setGroup] = useState<ParallelGroupDetail | null>(null);
  const [consolidating, setConsolidating] = useState(false);

  const fetchGroup = useCallback(async () => {
    try {
      const res = await fetch(`/api/parallel-groups/${groupId}`);
      if (res.ok) {
        setGroup(await res.json());
      }
    } catch (e) {
      console.error("Failed to fetch parallel group:", e);
    }
  }, [groupId]);

  useEffect(() => {
    fetchGroup();
    const interval = setInterval(fetchGroup, 5000);
    return () => clearInterval(interval);
  }, [fetchGroup]);

  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      const res = await fetch(`/api/parallel-groups/${groupId}/consolidate`, {
        method: "POST",
      });
      const result = await res.json();
      if (res.ok) {
        toast.success(`Merged ${result.mergedCount} branches successfully`);
        fetchGroup();
      } else {
        toast.error(result.error || "Consolidation failed");
      }
    } catch {
      toast.error("Consolidation failed");
    } finally {
      setConsolidating(false);
    }
  };

  if (!group) return null;

  const { summary } = group;
  const progressPct =
    summary.total > 0
      ? Math.round(
          ((summary.completed + summary.failed) / summary.total) * 100
        )
      : 0;

  return (
    <Card className="border-indigo-200 dark:border-indigo-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitFork className="h-4 w-4 text-indigo-600" />
          {group.name || "Parallel Group"}
          <Badge
            className={
              isTerminalTask(group.status)
                ? (group.status === "completed"
                    ? "bg-green-100 text-green-800"
                    : "bg-red-100 text-red-800")
                : "bg-indigo-100 text-indigo-800"
            }
          >
            {group.status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Progress bar */}
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>
              {summary.completed} of {summary.total} complete
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-green-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Child run list */}
        <div className="space-y-1">
          {group.childRuns.map((run) => (
            <button
              key={run.id}
              onClick={() => onRunClick?.(run.id)}
              className="flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-muted/50 transition-colors"
            >
              {taskFeedIcon[run.status] ?? taskFeedIcon.pending}
              <span className="flex-1 truncate">
                {run.title || run.id.slice(0, 8)}
              </span>
              <Badge
                variant="outline"
                className={`text-xs ${taskBadgeClass[run.status] ?? ""}`}
              >
                {run.status.replace(/_/g, " ")}
              </Badge>
            </button>
          ))}
        </div>

        {/* Summary stats */}
        {summary.failed > 0 && (
          <p className="mt-2 text-xs text-red-600">
            {summary.failed} run(s) failed
          </p>
        )}

        {/* Consolidate button — shown when all runs are done */}
        {summary.completed > 0 &&
          summary.completed + summary.failed === summary.total &&
          group.status !== "completed" && (
            <Button
              className="mt-3 w-full"
              onClick={handleConsolidate}
              disabled={consolidating}
            >
              {consolidating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <GitMerge className="mr-2 h-4 w-4" />
              )}
              Consolidate &amp; Merge ({summary.completed} branches)
            </Button>
          )}

        {group.status === "completed" && (
          <p className="mt-2 flex items-center gap-1 text-xs text-green-600">
            <CheckCircle className="h-3.5 w-3.5" />
            All branches merged successfully
          </p>
        )}
      </CardContent>
    </Card>
  );
}
