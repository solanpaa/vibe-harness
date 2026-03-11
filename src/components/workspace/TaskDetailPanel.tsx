"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Play,
  Square,
  Trash2,
  Workflow,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import type { EnrichedTask } from "./TaskFeed";
import { TerminalOutput } from "./TerminalOutput";
import { Markdown } from "@/components/ui/markdown";
import { taskStatusConfig } from "@/lib/status-config";

// ─── Detailed task (includes output) ─────────────────────────────────────────

interface TaskDetail {
  id: string;
  projectId: string;
  agentDefinitionId: string;
  sandboxId: string | null;
  status: string;
  prompt: string;
  output: string | null;
  model: string | null;
  workflowRunId: string | null;
  stageName: string | null;
  originTaskId: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface TaskDetailPanelProps {
  /** The enriched task from the feed (lightweight, no output) */
  task: EnrichedTask;
  /** Called when the task is deleted so the parent can deselect */
  onTaskDeleted?: (taskId: string) => void;
  /** Called when task status changes (after start/stop/review action) */
  onTaskChanged?: () => void;
}

export function TaskDetailPanel({
  task,
  onTaskDeleted,
  onTaskChanged,
}: TaskDetailPanelProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);

  const fetchDetail = useCallback(() => {
    fetch(`/api/tasks/${task.id}`)
      .then((r) => r.json())
      .then((data: TaskDetail) => setDetail(data))
      .catch(() => {});
  }, [task.id]);

  // Load detail on selection change
  useEffect(() => {
    setDetail(null);
    fetchDetail();
  }, [task.id, fetchDetail]);

  // Poll for status changes when not running (running uses SSE)
  useEffect(() => {
    if (!detail) return;
    if (
      detail.status === "completed" ||
      detail.status === "failed" ||
      detail.status === "running"
    )
      return;

    const interval = setInterval(fetchDetail, 3000);
    return () => clearInterval(interval);
  }, [detail?.status, fetchDetail]);

  async function handleStart() {
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDetail(updated);
      onTaskChanged?.();
      toast.success("Task started");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(`Failed to start: ${err?.error ?? "Unknown error"}`);
    }
  }

  async function handleStop() {
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDetail(updated);
      onTaskChanged?.();
      toast.success("Task stopped");
    }
  }

  async function handleDelete() {
    if (!window.confirm("Are you sure you want to delete this task?")) return;
    const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Task deleted");
      onTaskDeleted?.(task.id);
    } else {
      toast.error("Failed to delete task");
    }
  }

  function handleStreamClose() {
    fetchDetail();
    onTaskChanged?.();
  }

  const config = taskStatusConfig[detail?.status ?? task.status] ?? taskStatusConfig.pending;
  const currentStatus = detail?.status ?? task.status;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header — elevated surface ─────────────────────────── */}
      <div className="shrink-0 bg-card border-b shadow-sm">
        <div className="p-4 pb-3">
          {/* Title row */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">
                {task.projectName}
              </h2>
              {task.stageName && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Stage: {task.stageName}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {currentStatus === "pending" && (
                <Button size="sm" onClick={handleStart}>
                  <Play className="mr-1 h-3 w-3" />
                  Start
                </Button>
              )}
              {currentStatus === "running" && (
                <Button size="sm" variant="destructive" onClick={handleStop}>
                  <Square className="mr-1 h-3 w-3" />
                  Stop
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={handleDelete}
                disabled={currentStatus === "running"}
                title={currentStatus === "running" ? "Stop the task before deleting" : "Delete task"}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Metadata badges */}
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <Badge className={config.colorClass}>
            <span className="mr-1">{config.icon}</span>
            {config.label}
          </Badge>
          <Badge variant="outline">{task.agentName}</Badge>
          {task.model && (
            <Badge variant="secondary" className="text-xs">
              {task.model}
            </Badge>
          )}
          {task.workflow && (
            <Badge variant="outline" className="gap-1">
              <Workflow className="h-3 w-3" />
              {task.workflow.templateName}
              {task.stageName && (
                <>
                  <span className="text-muted-foreground">·</span>
                  {task.stageName}
                  <span className="text-muted-foreground">
                    (
                    {(task.workflow.stages.findIndex(
                      (s) => s.name === task.stageName,
                    ) ?? 0) + 1}
                    /{task.workflow.stages.length})
                  </span>
                </>
              )}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {new Date(task.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      {/* ── Prompt (collapsible) ────────────────────────────────── */}
      <div className="shrink-0 border-b bg-card">
        <button
          className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          onClick={() => setPromptExpanded((v) => !v)}
        >
          {promptExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Prompt
          {!promptExpanded && (
            <span className="truncate text-muted-foreground/70 font-normal">
              — {task.prompt.slice(0, 80)}{task.prompt.length > 80 ? "…" : ""}
            </span>
          )}
        </button>
        {promptExpanded && (
          <div className="px-4 pb-3 border-t bg-muted/20">
            <div className="pt-3">
              <Markdown>{task.prompt}</Markdown>
            </div>
          </div>
        )}
      </div>

      {/* ── Terminal output ─────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalOutput
          taskId={task.id}
          status={currentStatus}
          initialOutput={detail?.output ?? null}
          sandboxId={detail?.sandboxId ?? null}
          onStreamClose={handleStreamClose}
        />
      </div>
    </div>
  );
}
