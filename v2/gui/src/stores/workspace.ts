import { create } from "zustand";
import type {
  WorkflowRunSummary,
  WorkflowRunStatus,
} from "@vibe-harness/shared";

interface WorkspaceState {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  statusFilter: WorkflowRunStatus | null;
  loading: boolean;

  setRuns: (runs: WorkflowRunSummary[]) => void;
  selectRun: (id: string | null) => void;
  setStatusFilter: (status: WorkflowRunStatus | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  runs: [],
  selectedRunId: null,
  statusFilter: null,
  loading: false,

  setRuns: (runs) => set({ runs }),
  selectRun: (id) => set({ selectedRunId: id }),
  setStatusFilter: (status) => set({ statusFilter: status }),
  setLoading: (loading) => set({ loading }),
}));
