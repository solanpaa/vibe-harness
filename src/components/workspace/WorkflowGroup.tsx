"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TaskFeedItem } from "./TaskFeedItem";
import { ReviewFeedItem } from "./ReviewFeedItem";
import type { EnrichedTask } from "./TaskFeed";
import type { Selection } from "@/lib/types";

export interface WorkflowGroupProps {
  workflowName: string;
  runTitle?: string | null;
  runStatus: string;
  stages: Array<{ name: string }>;
  currentStage: string;
  tasks: EnrichedTask[];
  selection: Selection | null;
  onSelectTask: (taskId: string) => void;
  onSelectReview: (reviewId: string, taskId: string) => void;
}

const statusBadgeClass: Record<string, string> = {
  pending:
    "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
  running:
    "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  awaiting_review:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  completed:
    "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  failed:
    "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
};

export function WorkflowGroup({
  workflowName,
  runTitle,
  runStatus,
  stages,
  currentStage,
  tasks,
  selection,
  onSelectTask,
  onSelectReview,
}: WorkflowGroupProps) {
  const [expanded, setExpanded] = useState(true);

  const completedCount = tasks.filter(
    (t) => t.status === "completed",
  ).length;

  // Find the best task to select when clicking the workflow title
  const bestTask =
    tasks.find((t) => t.status === "running") ??
    tasks.find((t) => t.status === "awaiting_review") ??
    [...tasks].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];

  // Sort tasks by their position in the stages array
  const stageOrder = new Map(stages.map((s, i) => [s.name, i]));
  const sortedTasks = [...tasks].sort((a, b) => {
    const aIdx = stageOrder.get(a.stageName ?? "") ?? Infinity;
    const bIdx = stageOrder.get(b.stageName ?? "") ?? Infinity;
    return aIdx - bIdx;
  });

  const isTaskSelected = (taskId: string) =>
    selection?.kind === "task" && selection.taskId === taskId;

  const isReviewSelected = (reviewId: string) =>
    selection?.kind === "review" && selection.reviewId === reviewId;

  return (
    <div className="space-y-0.5">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Workflow className="size-4 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            if (bestTask) {
              onSelectTask(bestTask.id);
              setExpanded(true);
            }
          }}
        >
          {runTitle ?? workflowName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {completedCount}/{stages.length}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0 text-[10px] leading-tight capitalize",
            statusBadgeClass[runStatus] ?? "",
          )}
        >
          {runStatus.replace(/_/g, " ")}
        </Badge>
      </button>

      {/* Stage tasks with injected review items */}
      {expanded && (
        <div className="ml-3 border-l-2 border-border pl-1 space-y-0.5">
          {sortedTasks.map((task) => (
            <div key={task.id}>
              <TaskFeedItem
                task={task}
                isSelected={isTaskSelected(task.id)}
                isNested
                onClick={() => onSelectTask(task.id)}
              />
              {/* Injected review stage */}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
