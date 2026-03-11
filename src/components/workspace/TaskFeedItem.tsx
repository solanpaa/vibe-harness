"use client";

import {
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  GitPullRequestArrow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichedTask } from "./TaskFeed";

export interface TaskFeedItemProps {
  task: EnrichedTask;
  isSelected: boolean;
  isNested?: boolean;
  onClick: () => void;
}

const statusIcon: Record<string, React.ReactNode> = {
  pending: <Clock className="size-4 text-gray-400" />,
  running: <Loader2 className="size-4 animate-spin text-blue-500" />,
  awaiting_review: <GitPullRequestArrow className="size-4 text-yellow-500" />,
  completed: <CheckCircle className="size-4 text-green-500" />,
  failed: <XCircle className="size-4 text-red-500" />,
};

export function TaskFeedItem({
  task,
  isSelected,
  isNested = false,
  onClick,
}: TaskFeedItemProps) {
  const icon = statusIcon[task.status] ?? (
    <Clock className="size-4 text-gray-400" />
  );

  const label = isNested
    ? task.title ?? task.stageName ?? "Unknown stage"
    : task.title ?? task.projectName;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
        isNested ? "pl-4" : "pl-2",
        isSelected
          ? "bg-accent"
          : "hover:bg-muted/60",
      )}
    >
      {/* Status icon */}
      <span className="mt-0.5 shrink-0">{icon}</span>

      {/* Content */}
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-1">
          <span className="truncate text-sm font-medium">{label}</span>
        </span>
        <span className="flex items-center justify-between gap-1">
          <span className="truncate text-xs text-muted-foreground">
            {task.prompt}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTimeShort(task.createdAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

function relativeTimeShort(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
