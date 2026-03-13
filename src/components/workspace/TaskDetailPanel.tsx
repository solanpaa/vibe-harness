"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { Play, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { EnrichedTask } from "./TaskFeed";
import { TerminalOutput } from "./terminal";
import { ComparisonBanner } from "./ComparisonBanner";
import { ParallelGroupBanner } from "./ParallelGroupBanner";
import { TaskHeader } from "./TaskHeader";
import { ProposalReviewPanel } from "./ProposalReviewPanel";
import { taskStatusConfig, isTerminalTask, isActiveTask, shouldPollTask } from "@/lib/status-config";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

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
  comparisonGroupId: string | null;
  shellCommand: string | null;
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
  const [workflowRunStatus, setWorkflowRunStatus] = useState<string | null>(null);
  const [parallelGroupId, setParallelGroupId] = useState<string | null>(null);

  const poll = useWorkspaceStore((s) => s.poll);

  const fetchDetail = useCallback(() => {
    fetch(`/api/tasks/${task.id}`)
      .then((r) => r.json())
      .then((data: TaskDetail) => {
        setDetail(data);
        if (data.workflowRunId) {
          fetch(`/api/workflows/runs/${data.workflowRunId}`)
            .then((r) => r.json())
            .then((run) => {
              setWorkflowRunStatus(run.status ?? null);
              // For parent workflows with parallel groups, get the group ID
              setParallelGroupId(run.activeParallelGroupId ?? null);
            })
            .catch(() => {});
        } else {
          setWorkflowRunStatus(null);
          setParallelGroupId(null);
        }
      })
      .catch(() => {});
  }, [task.id]);

  // Load detail on selection change
  useEffect(() => {
    setDetail(null);
    fetchDetail();
  }, [task.id, fetchDetail]);

  // Poll for status changes when task needs polling but isn't streaming (running uses SSE)
  useEffect(() => {
    if (!detail) return;
    if (isTerminalTask(detail.status) || detail.status === "running") return;

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
      poll();
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
      toast.success("Task paused");
    }
  }

  async function handleResume(message?: string) {
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", message }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDetail(updated);
      onTaskChanged?.();
      toast.success("Task resumed");
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error ?? "Failed to resume task");
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
    poll();
  }

  const config = taskStatusConfig[detail?.status ?? task.status] ?? taskStatusConfig.pending;
  const currentStatus = detail?.status ?? task.status;

  return (
    <div className="flex h-full flex-col">
      <TaskHeader
        task={task}
        currentStatus={currentStatus}
        statusConfig={config}
        sandboxId={detail?.sandboxId ?? null}
        shellCommand={detail?.shellCommand ?? null}
        onStart={handleStart}
        onStop={handleStop}
        onResume={() => handleResume()}
        onDelete={handleDelete}
      />

      {/* Comparison banner (shown when task is part of a comparison group) */}
      {detail?.comparisonGroupId && (
        <ComparisonBanner
          comparisonGroupId={detail.comparisonGroupId}
          currentTaskId={task.id}
          onTaskChanged={onTaskChanged}
        />
      )}

      {/* Proposal review panel (shown when workflow is awaiting split review) */}
      {workflowRunStatus === "awaiting_split_review" && (
        <ProposalReviewPanel
          taskId={task.id}
          onLaunched={() => {
            fetchDetail();
            onTaskChanged?.();
          }}
        />
      )}

      {/* Parallel group banner (shown when children are executing) */}
      {workflowRunStatus === "running_parallel" && parallelGroupId && (
        <ParallelGroupBanner groupId={parallelGroupId} />
      )}

      {/* Resume input bar when paused */}
      {currentStatus === "paused" && (
        <ResumeBar onResume={handleResume} />
      )}

      {/* ── Output with intervention input ─────────────────── */}
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

/** Inline bar for resuming a paused task with optional instructions */
function ResumeBar({ onResume }: { onResume: (message?: string) => void }) {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="shrink-0 border-b bg-orange-50 dark:bg-orange-950/30 p-3">
      <p className="mb-2 text-xs font-medium text-orange-700 dark:text-orange-400">
        Task paused — provide instructions or resume
      </p>
      <div className="flex gap-2">
        <Textarea
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onResume(message || undefined);
            }
          }}
          placeholder="Optional instructions for the agent…"
          className="min-h-[48px] max-h-[100px] resize-none text-sm"
        />
        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={() => onResume(message || undefined)} className="h-8">
            <Send className="mr-1 h-3 w-3" />
            Resume
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onResume()}
            className="h-8 text-xs"
          >
            <Play className="mr-1 h-3 w-3" />
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
