"use client";

import { Clock, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichedTask } from "./TaskFeed";
import { taskFeedIcon } from "@/lib/status-config";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface TaskFeedItemProps {
  task: EnrichedTask;
  isSelected: boolean;
  isNested?: boolean;
  onClick: () => void;
  onDelete?: (taskId: string) => void;
}

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
  onDelete,
}: TaskFeedItemProps) {
  const icon = taskFeedIcon[task.status] ?? (
    <Clock className="size-3.5 text-muted-foreground/50" />
  );

  const label = isNested
    ? task.title ?? task.stageName ?? "Unknown stage"
    : task.title ?? task.projectName;

  const promptPreview = stripMarkdown(task.prompt);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          className="text-destructive"
          onClick={() => onDelete?.(task.id)}
        >
          <Trash2 className="size-3.5" />
          Delete task
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
