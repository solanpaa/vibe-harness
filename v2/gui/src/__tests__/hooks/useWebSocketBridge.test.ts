import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWebSocketBridge } from "../../hooks/useWebSocketBridge";
import { useWorkspaceStore } from "../../stores/workspace";
import type { WebSocketManager } from "../../api/ws";
import type { ServerMessage } from "@vibe-harness/shared";

function makeMockWs() {
  const listeners: Set<(msg: ServerMessage) => void> = new Set();
  return {
    onMessage: vi.fn((listener: (msg: ServerMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    // Test helper to simulate a server message
    _emit(msg: ServerMessage) {
      for (const l of listeners) l(msg);
    },
  } as unknown as WebSocketManager & { _emit: (msg: ServerMessage) => void };
}

describe("useWebSocketBridge", () => {
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

  it("registers onMessage listener when ws is provided", () => {
    const ws = makeMockWs();
    renderHook(() => useWebSocketBridge(ws as unknown as WebSocketManager));

    expect(ws.onMessage).toHaveBeenCalled();
  });

  it("does nothing when ws is null", () => {
    // Should not throw
    const { unmount } = renderHook(() => useWebSocketBridge(null));
    unmount();
  });

  it("run_status events update workspace store", () => {
    const ws = makeMockWs();
    const run = {
      id: "run-1",
      title: "Old title",
      description: null,
      status: "running" as const,
      currentStage: "plan",
      projectId: "p1",
      projectName: "Proj",
      workflowTemplateName: "default",
      branch: null,
      parentRunId: null,
      createdAt: "2024-01-01",
      completedAt: null,
    };
    useWorkspaceStore.getState().setRuns([run]);

    renderHook(() => useWebSocketBridge(ws as unknown as WebSocketManager));

    ws._emit({
      type: "run_status",
      runId: "run-1",
      status: "completed",
      currentStage: null,
      title: "New title",
      projectId: "p1",
    });

    const updated = useWorkspaceStore.getState().runs[0];
    expect(updated.status).toBe("completed");
    expect(updated.title).toBe("New title");
    expect(updated.currentStage).toBeNull();
  });

  it("stage_status events update run currentStage", () => {
    const ws = makeMockWs();
    const run = {
      id: "run-1",
      title: null,
      description: null,
      status: "running" as const,
      currentStage: "plan",
      projectId: "p1",
      projectName: "Proj",
      workflowTemplateName: "default",
      branch: null,
      parentRunId: null,
      createdAt: "2024-01-01",
      completedAt: null,
    };
    useWorkspaceStore.getState().setRuns([run]);

    renderHook(() => useWebSocketBridge(ws as unknown as WebSocketManager));

    ws._emit({
      type: "stage_status",
      runId: "run-1",
      stageName: "implement",
      round: 1,
      status: "running",
      failureReason: null,
    });

    expect(useWorkspaceStore.getState().runs[0].currentStage).toBe("implement");
  });

  it("review_created events add pending review and notification", () => {
    const ws = makeMockWs();
    renderHook(() => useWebSocketBridge(ws as unknown as WebSocketManager));

    ws._emit({
      type: "review_created",
      reviewId: "rev-1",
      runId: "run-1",
      stageName: "implement",
      round: 1,
      reviewType: "stage",
    });

    const state = useWorkspaceStore.getState();
    expect(state.pendingReviewRunIds.has("run-1")).toBe(true);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].message).toContain("Review ready");
    expect(state.notifications[0].level).toBe("info");
    expect(state.notifications[0].runId).toBe("run-1");
  });

  it("notification events add to notification list", () => {
    const ws = makeMockWs();
    renderHook(() => useWebSocketBridge(ws as unknown as WebSocketManager));

    ws._emit({
      type: "notification",
      level: "warning",
      message: "Something happened",
      runId: "run-2",
    });

    const notifs = useWorkspaceStore.getState().notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].level).toBe("warning");
    expect(notifs[0].message).toBe("Something happened");
    expect(notifs[0].runId).toBe("run-2");
  });

  it("cleans up listener on unmount", () => {
    const ws = makeMockWs();
    const { unmount } = renderHook(() =>
      useWebSocketBridge(ws as unknown as WebSocketManager)
    );

    unmount();

    // Emit after unmount — should not add notifications
    ws._emit({
      type: "notification",
      level: "info",
      message: "After unmount",
    });

    expect(useWorkspaceStore.getState().notifications).toHaveLength(0);
  });
});
