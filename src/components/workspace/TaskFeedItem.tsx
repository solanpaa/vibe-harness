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
  pending: <Clock className="size-3.5 text-gray-400" />,
  running: <Loader2 className="size-3.5 animate-spin text-blue-500" />,
  awaiting_review: <GitPullRequestArrow className="size-3.5 text-yellow-500" />,
  completed: <CheckCircle className="size-3.5 text-green-500" />,
  failed: <XCircle className="size-3.5 text-red-500" />,
};

/** Strip markdown syntax for clean preview text */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s*/g, "")      // headings
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1")     // italic
    .replace(/`(.+?)`/g, "$1")       // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .replace(/\n+/g, " ")           // newlines → spaces
    .replace(/\s{2,}/g, " ")        // collapse whitespace
    .trim();
}

export function TaskFeedItem({
  task,
  isSelected,
  isNested = false,
  onClick,
}: TaskFeedItemProps) {
  const icon = statusIcon[task.status] ?? (
    <Clock className="size-3.5 text-gray-400" />
  );

  const label = isNested
    ? task.title ?? task.stageName ?? "Unknown stage"
    : task.title ?? task.projectName;

  const promptPreview = stripMarkdown(task.prompt);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left transition-colors cursor-pointer",
        isNested ? "pl-3" : "pl-2",
        isSelected
          ? "bg-accent"
          : "hover:bg-muted/60",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-1">
          <span className="truncate text-[13px] font-medium leading-tight">{label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {relativeTimeShort(task.createdAt)}
          </span>
        </span>
        {(!isNested || !task.stageName) && (
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">
            {promptPreview}
          </span>
        )}
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
