"use client";

import { create } from "zustand";
import type { EnrichedTask } from "@/components/workspace/TaskFeed";
import type { Selection } from "@/lib/types";

// ─── Stats ───────────────────────────────────────────────────────────────────

interface Stats {
  activeTaskCount: number;
  pendingReviewCount: number;
}

// ─── Store shape ─────────────────────────────────────────────────────────────

interface WorkspaceState {
  // ── Data ──
  tasks: EnrichedTask[];
  stats: Stats;
  connected: boolean;
  loading: boolean;

  // ── Selection ──
  selection: Selection | null;
  setSelection: (sel: Selection | null) => void;

  // ── Actions ──
  /** Fetch the enriched task list and stats in one tick */
  poll: () => Promise<void>;
  /** Remove a task optimistically (after delete) */
  removeTask: (taskId: string) => void;
  /** Remove all tasks in a workflow run optimistically */
  removeWorkflowRun: (runId: string) => void;

  // ── Lifecycle ──
  /** Start the single polling loop. Returns a cleanup function. */
  startPolling: () => () => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function fetchTasks(): Promise<EnrichedTask[]> {
    const res = await fetch("/api/tasks?include=enriched");
    if (!res.ok) throw new Error("fetch tasks failed");
    return res.json();
  }

  async function fetchStats(): Promise<Stats> {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("fetch stats failed");
    const data = await res.json();
    return {
      activeTaskCount: data.activeTaskCount ?? 0,
      pendingReviewCount: data.pendingReviewCount ?? 0,
    };
  }

  return {
    tasks: [],
    stats: { activeTaskCount: 0, pendingReviewCount: 0 },
    connected: true,
    loading: true,
    selection: null,

    setSelection(sel) {
      set({ selection: sel });
    },

    async poll() {
      try {
        // Fetch tasks always; stats less frequently is handled by the caller
        const [tasks, stats] = await Promise.all([fetchTasks(), fetchStats()]);
        set({ tasks, stats, connected: true, loading: false });
      } catch {
        // If only stats fails, still update tasks
        try {
          const tasks = await fetchTasks();
          set({ tasks, loading: false });
        } catch {
          set({ connected: false, loading: false });
        }
      }
    },

    removeTask(taskId) {
      set((s) => ({
        tasks: s.tasks.filter((t) => t.id !== taskId),
        selection:
          s.selection &&
          ((s.selection.kind === "task" && s.selection.taskId === taskId) ||
            (s.selection.kind === "review" && s.selection.taskId === taskId))
            ? null
            : s.selection,
      }));
    },

    removeWorkflowRun(runId) {
      const { selection, tasks } = get();
      const affected = new Set(tasks.filter((t) => t.workflowRunId === runId).map((t) => t.id));
      const clearSelection =
        selection &&
        ((selection.kind === "task" && affected.has(selection.taskId)) ||
          (selection.kind === "review" && affected.has(selection.taskId)));
      set({
        tasks: tasks.filter((t) => t.workflowRunId !== runId),
        selection: clearSelection ? null : selection,
      });
    },

    startPolling() {
      // Initial fetch
      get().poll();

      // Poll every 3s — single loop for the whole workspace
      intervalId = setInterval(() => {
        // Only poll if there's something non-terminal, or periodically for new tasks
        get().poll();
      }, 3000);

      return () => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };
    },
  };
});
