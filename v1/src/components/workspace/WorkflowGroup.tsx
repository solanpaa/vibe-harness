"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Trash2, Workflow, GitMerge } from "lucide-react";
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
import { taskBadgeClass, isTerminalTask, isActiveTask, isReviewPending } from "@/lib/status-config";

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
  const completedStages = runStatus === "completed"
    ? stages.length
    : new Set(
        tasks
          .filter((t) => t.status === "completed" && t.stageName)
          .map((t) => t.stageName),
      ).size;

  // Build a flat timeline: tasks and reviews as independent items, newest first.
  // Reviews get their timestamp from the task they belong to, offset slightly
  // so they appear right after their task.
  type TimelineItem =
    | { kind: "task"; task: EnrichedTask; time: number }
    | { kind: "review"; reviewId: string; round: number; status: string; taskId: string; time: number }
    | { kind: "finalize"; time: number };

  const timeline: TimelineItem[] = [];
  for (const task of tasks) {
    timeline.push({ kind: "task", task, time: new Date(task.createdAt).getTime() });
    // Add ALL reviews for this task as separate timeline items
    const reviews = task.reviews ?? (task.latestReview ? [task.latestReview] : []);
    for (const review of reviews) {
      const reviewTime = review.createdAt
        ? new Date(review.createdAt).getTime()
        : new Date(task.completedAt ?? task.createdAt).getTime() + 1;
      timeline.push({
        kind: "review",
        reviewId: review.id,
        round: review.round,
        status: review.status,
        taskId: task.id,
        time: reviewTime,
      });
    }
  }

  // Add a finalize marker when the workflow completed successfully
  if (runStatus === "completed") {
    const latestTime = Math.max(...timeline.map((i) => i.time), 0);
    timeline.push({ kind: "finalize", time: latestTime + 1 });
  }

  timeline.sort((a, b) => b.time - a.time);

  const stageOrder = new Map(stages.map((s, i) => [s.name, i]));
  const sortedTasks = [...tasks].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Find the best task to select when clicking the workflow title
  const taskWithPendingReview = tasks.find(
    (t) => isReviewPending(t.latestReview?.status ?? "")
  );
  const latestTask = sortedTasks[0];
  const bestTask =
    tasks.find((t) => isActiveTask(t.status)) ??
    taskWithPendingReview ??
    latestTask;

  // Active items: running tasks or pending reviews
  const activeTimeline = timeline.filter((item) =>
    item.kind === "task"
      ? (isActiveTask(item.task.status) || isReviewPending(item.task.latestReview?.status ?? ""))
      : item.kind === "review"
        ? isReviewPending(item.status)
        : false
  );
  const visibleWhenCollapsed =
    activeTimeline.length > 0 ? activeTimeline : timeline.slice(0, 2);

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

  const displayItems = expanded ? timeline : visibleWhenCollapsed;
  const isFullyCompleted = isTerminalTask(runStatus);
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
                  // If there's a pending review, jump to it
                  if (bestTask.latestReview && isReviewPending(bestTask.latestReview.status)) {
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

      {/* Timeline: tasks and reviews as flat items */}
      {showStages && (
        <div className="ml-3 border-l border-border/60 pl-1 space-y-px">
          {displayItems.map((item) =>
            item.kind === "finalize" ? (
              <div
                key="finalize"
                className="flex items-center gap-2 rounded-md px-3 py-1 text-[13px] text-green-600 dark:text-green-400"
              >
                <GitMerge className="size-3.5" />
                <span className="font-medium">Merged to main</span>
              </div>
            ) : item.kind === "review" ? (
              <ReviewFeedItem
                key={`review-${item.reviewId}`}
                reviewId={item.reviewId}
                round={item.round}
                status={item.status}
                isSelected={isReviewSelected(item.reviewId)}
                isNested
                onClick={() => onSelectReview(item.reviewId, item.taskId)}
              />
            ) : (
              <TaskFeedItem
                key={`task-${item.task.id}`}
                task={item.task}
                isSelected={isTaskSelected(item.task.id)}
                isNested
                onClick={() => onSelectTask(item.task.id)}
              />
            )
          )}
          {/* Collapsed hint */}
          {!expanded && timeline.length > displayItems.length && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full px-3 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground text-left cursor-pointer"
            >
              +{timeline.length - displayItems.length} more…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
