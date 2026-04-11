import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunFeed } from "../../components/workspace/RunFeed";
import { useWorkspaceStore } from "../../stores/workspace";
import type { WorkflowRunSummary } from "@vibe-harness/shared";

const makeRun = (
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary => ({
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
  createdAt: new Date().toISOString(),
  completedAt: null,
  ...overrides,
});

describe("RunFeed", () => {
  const onSelectRun = vi.fn();
  const onNewRun = vi.fn();

  beforeEach(() => {
    onSelectRun.mockReset();
    onNewRun.mockReset();
    useWorkspaceStore.setState({
      runs: [],
      selectedRunId: null,
      statusFilter: null,
      loading: false,
    });
  });

  it("renders a list of runs", () => {
    useWorkspaceStore.setState({
      runs: [
        makeRun({ id: "r1", title: "First run" }),
        makeRun({ id: "r2", title: "Second run" }),
        makeRun({ id: "r3", title: "Third run" }),
      ],
    });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    expect(screen.getByText("First run")).toBeInTheDocument();
    expect(screen.getByText("Second run")).toBeInTheDocument();
    expect(screen.getByText("Third run")).toBeInTheDocument();
  });

  it("filters runs when a status chip is clicked", () => {
    useWorkspaceStore.setState({
      runs: [
        makeRun({ id: "r1", title: "Active", status: "running" }),
        makeRun({ id: "r2", title: "Done", status: "completed" }),
      ],
    });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    // Both visible initially
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    // Click "Completed" filter chip (use getAllByText since the label also appears in StatusBadge)
    const completedButtons = screen.getAllByText("Completed");
    // The filter chip is a standalone button, not inside a StatusBadge span
    const chipButton = completedButtons.find(
      (el) => el.tagName === "BUTTON",
    )!;
    fireEvent.click(chipButton);

    // Only the completed run should remain
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows all runs again when 'All' chip is clicked after filtering", () => {
    useWorkspaceStore.setState({
      runs: [
        makeRun({ id: "r1", title: "Active", status: "running" }),
        makeRun({ id: "r2", title: "Done", status: "completed" }),
      ],
    });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    const runningButtons = screen.getAllByText("Running");
    const chipButton = runningButtons.find(
      (el) => el.tagName === "BUTTON",
    )!;
    fireEvent.click(chipButton);
    expect(screen.queryByText("Done")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("All"));
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("calls onSelectRun when a run card is clicked", () => {
    useWorkspaceStore.setState({
      runs: [makeRun({ id: "r1", title: "Click me" })],
    });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    fireEvent.click(screen.getByText("Click me"));
    expect(onSelectRun).toHaveBeenCalledWith("r1");
  });

  it("renders 'New Run' button and calls onNewRun when clicked", () => {
    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    const btn = screen.getByText("+ New Run");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onNewRun).toHaveBeenCalledOnce();
  });

  it("shows empty state message when no runs exist", () => {
    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows filtered empty state when filter has no matches", () => {
    useWorkspaceStore.setState({
      runs: [makeRun({ id: "r1", status: "running" })],
    });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    fireEvent.click(screen.getByText("Failed"));
    expect(screen.getByText("No runs with this status")).toBeInTheDocument();
  });

  it("shows loading indicator while loading", () => {
    useWorkspaceStore.setState({ loading: true });

    render(
      <RunFeed
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onNewRun={onNewRun}
      />,
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
