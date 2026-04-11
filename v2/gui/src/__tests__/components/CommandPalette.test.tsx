// ---------------------------------------------------------------------------
// Tests for CommandPalette component
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandPalette } from "../../components/shared/CommandPalette";
import { useWorkspaceStore } from "../../stores/workspace";

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

describe("CommandPalette", () => {
  const onClose = vi.fn();
  const onNewRun = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
    onNewRun.mockReset();
    mockNavigate.mockReset();
    useWorkspaceStore.setState({
      runs: [],
      selectedRunId: null,
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <CommandPalette open={false} onClose={onClose} onNewRun={onNewRun} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders when open", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    expect(
      screen.getByPlaceholderText("Type a command or search..."),
    ).toBeDefined();
  });

  it("shows navigation commands", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    expect(screen.getByText("Go to Workspace")).toBeDefined();
    expect(screen.getByText("Go to Projects")).toBeDefined();
    expect(screen.getByText("Go to Workflows")).toBeDefined();
    expect(screen.getByText("Go to Credentials")).toBeDefined();
    expect(screen.getByText("Go to Settings")).toBeDefined();
  });

  it("shows 'New Run' action", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    expect(screen.getByText("New Run")).toBeDefined();
  });

  it("filters commands by query", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    const input = screen.getByPlaceholderText("Type a command or search...");
    fireEvent.change(input, { target: { value: "cred" } });
    // Should show Credentials but not others
    expect(screen.getByText("Go to Credentials")).toBeDefined();
    expect(screen.queryByText("Go to Projects")).toBeNull();
  });

  it("shows 'No results found' for non-matching query", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    const input = screen.getByPlaceholderText("Type a command or search...");
    fireEvent.change(input, { target: { value: "zzzzzzz" } });
    expect(screen.getByText("No results found")).toBeDefined();
  });

  it("calls onClose when backdrop is clicked", () => {
    const { container } = render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    // Click the outer backdrop div
    const backdrop = container.querySelector(".fixed.inset-0");
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    const palette = screen.getByPlaceholderText("Type a command or search...")
      .closest("div[class*='overflow-hidden']")!;
    fireEvent.keyDown(palette, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates when a command is clicked", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    fireEvent.click(screen.getByText("Go to Projects"));
    expect(mockNavigate).toHaveBeenCalledWith("/projects");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows recent runs when they exist", () => {
    useWorkspaceStore.setState({
      runs: [
        {
          id: "run-1",
          title: "My Run",
          description: "Test desc",
          status: "running",
          currentStage: "implement",
          projectId: "p1",
          projectName: "Proj",
          workflowTemplateName: "default",
          branch: "main",
          parentRunId: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
      ] as any,
      selectedRunId: null,
    });

    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );

    expect(screen.getByText(/Test desc/)).toBeDefined();
  });

  it("group headers are displayed", () => {
    render(
      <CommandPalette open={true} onClose={onClose} onNewRun={onNewRun} />,
    );
    expect(screen.getByText("Navigation")).toBeDefined();
    expect(screen.getByText("Actions")).toBeDefined();
  });
});
