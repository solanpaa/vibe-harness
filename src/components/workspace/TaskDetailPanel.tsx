"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { EnrichedTask } from "./TaskFeed";
import { TerminalOutput } from "./terminal";
import { TaskHeader } from "./TaskHeader";
import { TaskPrompt } from "./TaskPrompt";
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
      <TaskHeader
        task={task}
        currentStatus={currentStatus}
        statusConfig={config}
        onStart={handleStart}
        onStop={handleStop}
        onDelete={handleDelete}
      />

      <TaskPrompt prompt={task.prompt} />

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
