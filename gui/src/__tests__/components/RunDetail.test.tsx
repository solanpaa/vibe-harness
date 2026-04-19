import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RunDetail } from "../../components/run/RunDetail";
import { useDaemonStore } from "../../stores/daemon";
import { useStreamingStore } from "../../stores/streaming";
import type { WorkflowRunDetailResponse } from "@vibe-harness/shared";

function makeDetail(
  overrides: Partial<WorkflowRunDetailResponse> = {},
): WorkflowRunDetailResponse {
  return {
    id: "run-1",
    title: "Implement auth",
    description: "Add JWT authentication",
    status: "running",
    currentStage: "implement",
    projectId: "proj-1",
    projectName: "My Project",
    workflowTemplateId: "tmpl-1",
    workflowTemplateName: "Plan-Implement-Review",
    agentDefinitionId: "agent-1",
    parentRunId: null,
    parallelGroupId: null,
    sandboxId: "sb-abc12345",
    worktreePath: "/worktree/path",
    branch: "feature/auth",
    baseBranch: "main",
    targetBranch: "vibe/auth",
    credentialSetId: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    stages: [
      {
        id: "se-1",
        workflowRunId: "run-1",
        stageName: "plan",
        round: 1,
        status: "completed",
        prompt: null,
        freshSession: false,
        model: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        failureReason: null,
        usageStats: null,
        reviewId: null,
      },
      {
        id: "se-2",
        workflowRunId: "run-1",
        stageName: "implement",
        round: 1,
        status: "running",
        prompt: null,
        freshSession: false,
        model: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        failureReason: null,
        usageStats: null,
        reviewId: null,
      },
    ],
    activeReviewId: null,
    childRunIds: [],
    ...overrides,
  };
}

function makeMockClient(detail: WorkflowRunDetailResponse) {
  return {
    getRun: vi.fn().mockResolvedValue(detail),
    getRunMessages: vi.fn().mockResolvedValue({ messages: [] }),
    cancelRun: vi.fn().mockResolvedValue({ status: "cancelled" }),
  };
}

const mockWs = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
};

describe("RunDetail", () => {
  beforeEach(() => {
    useStreamingStore.setState({
      buffers: new Map(),
      wsState: "open",
      resyncRequired: new Set(),
    });
  });

  function setupWithDetail(detail: WorkflowRunDetailResponse) {
    const client = makeMockClient(detail);
    useDaemonStore.setState({
      client: client as any,
      connected: true,
      port: 3000,
      lastError: null,
      lastHealthCheck: null,
    });
    return client;
  }

  it("shows run title and status badge", async () => {
    const detail = makeDetail({ title: "Implement auth", status: "running" });
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("Implement auth")).toBeInTheDocument();
    });
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("shows project name and template name", async () => {
    const detail = makeDetail();
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });
    expect(screen.getByText("Plan-Implement-Review")).toBeInTheDocument();
  });

  it("renders stage timeline with correct number of stages", async () => {
    const detail = makeDetail();
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
    });
    expect(screen.getByText("implement")).toBeInTheDocument();
  });

  it("shows Cancel button for running runs", async () => {
    const detail = makeDetail({ status: "running" });
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });
  });

  it("hides Cancel button for completed runs", async () => {
    const detail = makeDetail({
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("Implement auth")).toBeInTheDocument();
    });
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("hides Cancel button for failed runs", async () => {
    const detail = makeDetail({ status: "failed" });
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("Implement auth")).toBeInTheDocument();
    });
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("calls cancelRun when Cancel button is clicked", async () => {
    const detail = makeDetail({ status: "running" });
    const client = setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(client.cancelRun).toHaveBeenCalledWith("run-1");
    });
  });

  it("shows loading state initially", () => {
    const detail = makeDetail();
    const client = makeMockClient(detail);
    // Make getRun never resolve to keep loading state
    client.getRun.mockReturnValue(new Promise(() => {}));
    useDaemonStore.setState({
      client: client as any,
      connected: true,
      port: 3000,
      lastError: null,
      lastHealthCheck: null,
    });

    render(<RunDetail runId="run-1" ws={mockWs as any} />);
    expect(screen.getByText("Loading run details...")).toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    const client = {
      getRun: vi.fn().mockRejectedValue(new Error("Network failure")),
      getRunMessages: vi.fn().mockResolvedValue({ messages: [] }),
      cancelRun: vi.fn(),
    };
    useDaemonStore.setState({
      client: client as any,
      connected: true,
      port: 3000,
      lastError: null,
      lastHealthCheck: null,
    });

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(screen.getByText(/Network failure/)).toBeInTheDocument();
    });
  });

  it("falls back to truncated description when title is null", async () => {
    const detail = makeDetail({
      title: null,
      description: "Add JWT authentication to the API server",
    });
    setupWithDetail(detail);

    render(<RunDetail runId="run-1" ws={mockWs as any} />);

    await waitFor(() => {
      expect(
        screen.getByText("Add JWT authentication to the API server"),
      ).toBeInTheDocument();
    });
  });
});
