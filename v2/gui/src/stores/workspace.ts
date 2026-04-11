import { create } from "zustand";
import type {
  WorkflowRunSummary,
  WorkflowRunStatus,
} from "@vibe-harness/shared";

export interface AppNotification {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  runId?: string;
  timestamp: number;
}

interface WorkspaceState {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  statusFilter: WorkflowRunStatus | null;
  loading: boolean;
  notifications: AppNotification[];
  pendingReviewRunIds: Set<string>;
  newRunModalOpen: boolean;

  setRuns: (runs: WorkflowRunSummary[]) => void;
  selectRun: (id: string | null) => void;
  setStatusFilter: (status: WorkflowRunStatus | null) => void;
  setLoading: (loading: boolean) => void;
  /** Patch a single run in the list (e.g. from a WS status event). */
  updateRun: (runId: string, patch: Partial<WorkflowRunSummary>) => void;
  addNotification: (notification: AppNotification) => void;
  dismissNotification: (id: string) => void;
  addPendingReview: (runId: string) => void;
  setNewRunModalOpen: (open: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  runs: [],
  selectedRunId: null,
  statusFilter: null,
  loading: false,
  notifications: [],
  pendingReviewRunIds: new Set(),
  newRunModalOpen: false,

  setRuns: (runs) => set({ runs }),
  selectRun: (id) => set({ selectedRunId: id }),
  setStatusFilter: (status) => set({ statusFilter: status }),
  setLoading: (loading) => set({ loading }),
  setNewRunModalOpen: (open) => set({ newRunModalOpen: open }),

  updateRun: (runId, patch) =>
    set((state) => ({
      runs: state.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
    })),

  addNotification: (notification) =>
    set((state) => ({
      notifications: [...state.notifications, notification],
    })),

  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  addPendingReview: (runId) =>
    set((state) => {
      const pendingReviewRunIds = new Set(state.pendingReviewRunIds);
      pendingReviewRunIds.add(runId);
      return { pendingReviewRunIds };
    }),
}));
