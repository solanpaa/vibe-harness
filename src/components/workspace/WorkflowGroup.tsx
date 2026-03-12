"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Trash2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TaskFeedItem } from "./TaskFeedItem";
import { ReviewFeedItem } from "./ReviewFeedItem";
import type { EnrichedTask } from "./TaskFeed";
import type { Selection } from "@/lib/types";
import { taskBadgeClass } from "@/lib/status-config";

export interface WorkflowGroupProps {
  workflowName: string;
  runId: string;
  runTitle?: string | null;
  runStatus: string;
  stages: Array<{ name: string }>;
  currentStage: string;
  tasks: EnrichedTask[];
  selection: Selection | null;
  onSelectTask: (taskId: string) => void;
  onSelectReview: (reviewId: string, taskId: string) => void;
  onDeleteRun?: (runId: string) => void;
}

export function WorkflowGroup({
  workflowName,
  runId,
  runTitle,
  runStatus,
  stages,
  currentStage,
  tasks,
  selection,
  onSelectTask,
  onSelectReview,
  onDeleteRun,
}: WorkflowGroupProps) {
  const [expanded, setExpanded] = useState(false);

  // Count unique completed stages (not total tasks, since reruns create extras)
  const completedStages = new Set(
    tasks
      .filter((t) => t.status === "completed" && t.stageName)
      .map((t) => t.stageName),
  ).size;

  // Sort tasks by their position in the stages array (latest stage first)
  const stageOrder = new Map(stages.map((s, i) => [s.name, i]));
  const sortedTasks = [...tasks].sort((a, b) => {
    const aIdx = stageOrder.get(a.stageName ?? "") ?? Infinity;
    const bIdx = stageOrder.get(b.stageName ?? "") ?? Infinity;
    return bIdx - aIdx;
  });

  // Find the best task to select when clicking the workflow title:
  // latest stage first, preferring running > awaiting_review > newest
  const latestTask = [...tasks].sort((a, b) => {
    const aIdx = stageOrder.get(a.stageName ?? "") ?? -1;
    const bIdx = stageOrder.get(b.stageName ?? "") ?? -1;
    if (aIdx !== bIdx) return bIdx - aIdx;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  })[0];
  const bestTask =
    tasks.find((t) => t.status === "running") ??
    tasks.find((t) => t.status === "awaiting_review") ??
    latestTask;

  // Active tasks: running or awaiting review (+ latest completed if none active)
  const activeTasks = sortedTasks.filter(
    (t) => t.status === "running" || t.status === "awaiting_review",
  );
  const visibleWhenCollapsed =
    activeTasks.length > 0 ? activeTasks : sortedTasks.slice(0, 1);

  // Auto-expand when a child task/review is selected
  const hasSelectedChild = tasks.some(
    (t) =>
      (selection?.kind === "task" && selection.taskId === t.id) ||
      (selection?.kind === "review" && selection.taskId === t.id),
  );

  useEffect(() => {
    if (hasSelectedChild && !expanded) setExpanded(true);
  }, [hasSelectedChild]);

  const isTaskSelected = (taskId: string) =>
    selection?.kind === "task" && selection.taskId === taskId;

  const isReviewSelected = (reviewId: string) =>
    selection?.kind === "review" && selection.reviewId === reviewId;

  const displayTasks = expanded ? sortedTasks : visibleWhenCollapsed;
  const isFullyCompleted = runStatus === "completed" || runStatus === "failed";
  const showStages = expanded || !isFullyCompleted;

  return (
    <div className="space-y-px">
      {/* Header */}
      <ContextMenu>
        <ContextMenuTrigger>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60 cursor-pointer"
          >
            {expanded ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                if (bestTask) {
                  // If the task is awaiting review and has a review, jump to the review
                  if (bestTask.status === "awaiting_review" && bestTask.latestReview) {
                    onSelectReview(bestTask.latestReview.id, bestTask.id);
                  } else {
                    onSelectTask(bestTask.id);
                  }
                  setExpanded(true);
                }
              }}
            >
              {runTitle ?? workflowName}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {completedStages}/{stages.length}
            </span>
            <Badge
              variant="secondary"
              className={cn(
                "shrink-0 text-[10px] leading-none px-1.5 py-0 h-4 capitalize",
                taskBadgeClass[runStatus] ?? "",
              )}
            >
              {runStatus.replace(/_/g, " ")}
            </Badge>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            className="text-destructive"
            onClick={() => onDeleteRun?.(runId)}
          >
            <Trash2 className="size-3.5" />
            Delete workflow run
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Stage tasks */}
      {showStages && (
        <div className="ml-3 border-l border-border/60 pl-1 space-y-px">
          {displayTasks.map((task) => (
            <div key={task.id}>
              {task.latestReview && (
                <ReviewFeedItem
                  reviewId={task.latestReview.id}
                  round={task.latestReview.round}
                  status={task.latestReview.status}
                  isSelected={isReviewSelected(task.latestReview.id)}
                  isNested
                  onClick={() =>
                    onSelectReview(task.latestReview!.id, task.id)
                  }
                />
              )}
              <TaskFeedItem
                task={task}
                isSelected={isTaskSelected(task.id)}
                isNested
                onClick={() => onSelectTask(task.id)}
              />
            </div>
          ))}
          {/* Collapsed hint */}
          {!expanded && sortedTasks.length > displayTasks.length && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full px-3 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground text-left cursor-pointer"
            >
              +{sortedTasks.length - displayTasks.length} more stage{sortedTasks.length - displayTasks.length > 1 ? "s" : ""}…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
