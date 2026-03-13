"use client";

import { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { toast } from "sonner";
import { WorkspaceLayout } from "@/components/workspace/WorkspaceLayout";
import { TaskFeed } from "@/components/workspace/TaskFeed";
import { TaskDetailPanel } from "@/components/workspace/TaskDetailPanel";
import { ReviewDetailPanel } from "@/components/workspace/ReviewDetailPanel";
import { NewTaskModal } from "@/components/workspace/NewTaskModal";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export default function WorkspacePage() {
  const tasks = useWorkspaceStore((s) => s.tasks);
  const selection = useWorkspaceStore((s) => s.selection);
  const setSelection = useWorkspaceStore((s) => s.setSelection);
  const loading = useWorkspaceStore((s) => s.loading);
  const poll = useWorkspaceStore((s) => s.poll);
  const removeTask = useWorkspaceStore((s) => s.removeTask);
  const removeWorkflowRun = useWorkspaceStore((s) => s.removeWorkflowRun);
  const startPolling = useWorkspaceStore((s) => s.startPolling);
  const [createOpen, setCreateOpen] = useState(false);

  // Single polling loop for the whole workspace
  useEffect(() => {
    return startPolling();
  }, [startPolling]);

  const selectedTaskId =
    selection?.kind === "task"
      ? selection.taskId
      : selection?.kind === "review"
        ? selection.taskId
        : null;

  // Build flat list of selectable task IDs for arrow navigation
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const selectedIndex = selectedTaskId ? taskIds.indexOf(selectedTaskId) : -1;

  useKeyboardShortcuts(
    useMemo(
      () => [
        {
          key: "n",
          meta: true,
          handler: () => setCreateOpen(true),
        },
        {
          key: "Escape",
          handler: () => setSelection(null),
        },
        {
          key: "ArrowDown",
          handler: () => {
            if (taskIds.length === 0) return;
            const next =
              selectedIndex < taskIds.length - 1 ? selectedIndex + 1 : 0;
            setSelection({ kind: "task", taskId: taskIds[next] });
          },
        },
        {
          key: "ArrowUp",
          handler: () => {
            if (taskIds.length === 0) return;
            const prev =
              selectedIndex > 0 ? selectedIndex - 1 : taskIds.length - 1;
            setSelection({ kind: "task", taskId: taskIds[prev] });
          },
        },
        {
          key: "j",
          handler: () => {
            if (taskIds.length === 0) return;
            const next =
              selectedIndex < taskIds.length - 1 ? selectedIndex + 1 : 0;
            setSelection({ kind: "task", taskId: taskIds[next] });
          },
        },
        {
          key: "k",
          handler: () => {
            if (taskIds.length === 0) return;
            const prev =
              selectedIndex > 0 ? selectedIndex - 1 : taskIds.length - 1;
            setSelection({ kind: "task", taskId: taskIds[prev] });
          },
        },
      ],
      [taskIds, selectedIndex],
    ),
  );

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  function handleSelectTask(taskId: string) {
    setSelection({ kind: "task", taskId });
  }

  function handleSelectReview(reviewId: string, taskId: string) {
    setSelection({ kind: "review", reviewId, taskId });
  }

  function handleTaskCreated(taskId: string) {
    setSelection({ kind: "task", taskId });
    poll();
  }

  function handleTaskDeleted(taskId: string) {
    removeTask(taskId);
  }

  async function handleDeleteRun(runId: string) {
    try {
      const res = await fetch(`/api/workflows/runs/${runId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete workflow run");
        return;
      }
      toast.success("Workflow run deleted");
      removeWorkflowRun(runId);
    } catch {
      toast.error("Failed to delete workflow run");
    }
  }

  async function handleDeleteTask(taskId: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete task");
        return;
      }
      toast.success("Task deleted");
      removeTask(taskId);
    } catch {
      toast.error("Failed to delete task");
    }
  }

  function renderDetailPanel() {
    if (!selection) {
      return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Terminal className="mx-auto h-12 w-12 opacity-30" />
            <p className="text-sm">Select a task or create a new one</p>
          </div>
        </div>
      );
    }

    if (selection.kind === "review") {
      return (
        <ReviewDetailPanel
          key={selection.reviewId}
          reviewId={selection.reviewId}
          taskId={selection.taskId}
          onNavigateToTask={(taskId) =>
            setSelection({ kind: "task", taskId })
          }
          onReviewAction={poll}
        />
      );
    }

    const task = tasks.find((t) => t.id === selection.taskId);
    if (!task) {
      return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Terminal className="mx-auto h-12 w-12 opacity-30" />
            <p className="text-sm">Task not found</p>
          </div>
        </div>
      );
    }

    return (
      <TaskDetailPanel
        key={task.id}
        task={task}
        onTaskDeleted={handleTaskDeleted}
        onTaskChanged={poll}
      />
    );
  }

  return (
    <>
      <WorkspaceLayout
        feedSlot={
          <TaskFeed
            tasks={tasks}
            selection={selection}
            onSelectTask={handleSelectTask}
            onSelectReview={handleSelectReview}
            onNewTask={() => setCreateOpen(true)}
            onDeleteRun={handleDeleteRun}
            onDeleteTask={handleDeleteTask}
            loading={loading}
          />
        }
        detailSlot={renderDetailPanel()}
        hasSelection={!!selection}
        onBackToFeed={() => setSelection(null)}
      />

      <NewTaskModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onTaskCreated={handleTaskCreated}
      />
    </>
  );
}
