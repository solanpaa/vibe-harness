import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore, type AppNotification } from "../../stores/workspace";
import type { WorkflowRunSummary } from "@vibe-harness/shared";

function getState() {
  return useWorkspaceStore.getState();
}

const makeRun = (overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id: "run-1",
  title: "Test run",
  description: "desc",
  status: "running",
  currentStage: "implement",
  projectId: "proj-1",
  projectName: "My Project",
  workflowTemplateName: "default",
  branch: "main",
  parentRunId: null,
  createdAt: "2024-01-01T00:00:00Z",
  completedAt: null,
  ...overrides,
});

describe("Workspace store", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      runs: [],
      selectedRunId: null,
      statusFilter: null,
      loading: false,
      notifications: [],
      pendingReviewRunIds: new Set(),
    });
  });

  it("selectRun sets selectedRunId", () => {
    getState().selectRun("run-42");
    expect(getState().selectedRunId).toBe("run-42");
  });

  it("selectRun(null) clears selection", () => {
    getState().selectRun("run-42");
    getState().selectRun(null);
    expect(getState().selectedRunId).toBeNull();
  });

  it("setStatusFilter updates filter", () => {
    getState().setStatusFilter("running");
    expect(getState().statusFilter).toBe("running");
  });

  it("setStatusFilter(null) clears filter", () => {
    getState().setStatusFilter("running");
    getState().setStatusFilter(null);
    expect(getState().statusFilter).toBeNull();
  });

  it("addNotification appends to notification list", () => {
    const notif: AppNotification = {
      id: "n-1",
      level: "info",
      message: "Hello",
      timestamp: Date.now(),
    };
    getState().addNotification(notif);

    expect(getState().notifications).toHaveLength(1);
    expect(getState().notifications[0].message).toBe("Hello");
  });

  it("addNotification preserves existing notifications", () => {
    const n1: AppNotification = { id: "n-1", level: "info", message: "First", timestamp: 1 };
    const n2: AppNotification = { id: "n-2", level: "warning", message: "Second", timestamp: 2 };

    getState().addNotification(n1);
    getState().addNotification(n2);

    expect(getState().notifications).toHaveLength(2);
    expect(getState().notifications.map((n) => n.id)).toEqual(["n-1", "n-2"]);
  });

  it("dismissNotification removes by id", () => {
    const n1: AppNotification = { id: "n-1", level: "info", message: "Keep", timestamp: 1 };
    const n2: AppNotification = { id: "n-2", level: "error", message: "Remove", timestamp: 2 };

    getState().addNotification(n1);
    getState().addNotification(n2);
    getState().dismissNotification("n-2");

    expect(getState().notifications).toHaveLength(1);
    expect(getState().notifications[0].id).toBe("n-1");
  });

  it("updateRun patches a run in the list by ID", () => {
    const run = makeRun({ id: "run-1", status: "running" });
    getState().setRuns([run]);

    getState().updateRun("run-1", { status: "completed" });

    expect(getState().runs[0].status).toBe("completed");
    // Other fields untouched
    expect(getState().runs[0].title).toBe("Test run");
  });

  it("updateRun does not affect other runs", () => {
    const run1 = makeRun({ id: "run-1", status: "running" });
    const run2 = makeRun({ id: "run-2", status: "pending" });
    getState().setRuns([run1, run2]);

    getState().updateRun("run-1", { status: "completed" });

    expect(getState().runs[1].status).toBe("pending");
  });

  it("addPendingReview adds runId to the set", () => {
    getState().addPendingReview("run-1");
    getState().addPendingReview("run-2");

    expect(getState().pendingReviewRunIds.has("run-1")).toBe(true);
    expect(getState().pendingReviewRunIds.has("run-2")).toBe(true);
  });

  it("setRuns replaces the entire list", () => {
    const runs = [makeRun({ id: "r1" }), makeRun({ id: "r2" })];
    getState().setRuns(runs);
    expect(getState().runs).toHaveLength(2);

    getState().setRuns([makeRun({ id: "r3" })]);
    expect(getState().runs).toHaveLength(1);
    expect(getState().runs[0].id).toBe("r3");
  });
});
