"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CheckCircle,
  Clock,
  GitFork,
  Loader2,
  XCircle,
} from "lucide-react";

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

// ─── Status helpers ──────────────────────────────────────────────────────────

const runStatusIcon: Record<string, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />,
  awaiting_review: (
    <GitFork className="h-3.5 w-3.5 text-yellow-500" />
  ),
  completed: <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-red-500" />,
};

const runStatusBadge: Record<string, string> = {
  pending: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  awaiting_review:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  completed:
    "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function ParallelGroupBanner({
  groupId,
  onRunClick,
}: ParallelGroupBannerProps) {
  const [group, setGroup] = useState<ParallelGroupDetail | null>(null);

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
              group.status === "completed"
                ? "bg-green-100 text-green-800"
                : group.status === "failed"
                  ? "bg-red-100 text-red-800"
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
              {runStatusIcon[run.status] ?? runStatusIcon.pending}
              <span className="flex-1 truncate">
                {run.title || run.id.slice(0, 8)}
              </span>
              <Badge
                variant="outline"
                className={`text-xs ${runStatusBadge[run.status] ?? ""}`}
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
      </CardContent>
    </Card>
  );
}
