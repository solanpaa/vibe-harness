import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageTimeline } from "../../components/run/StageTimeline";
import type { StageExecutionDetail } from "@vibe-harness/shared";

function makeStage(
  overrides: Partial<StageExecutionDetail> = {},
): StageExecutionDetail {
  return {
    id: "se-1",
    workflowRunId: "run-1",
    stageName: "plan",
    round: 1,
    status: "pending",
    prompt: null,
    freshSession: false,
    model: null,
    startedAt: null,
    completedAt: null,
    failureReason: null,
    usageStats: null,
    reviewId: null,
    ...overrides,
  };
}

describe("StageTimeline", () => {
  it("renders the correct number of stage indicators", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan" }),
      makeStage({ id: "s2", stageName: "implement" }),
      makeStage({ id: "s3", stageName: "review" }),
    ];

    render(<StageTimeline stages={stages} currentStage="plan" />);

    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
  });

  it("shows checkmark icon for completed stages", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "completed" }),
      makeStage({ id: "s2", stageName: "implement", status: "pending" }),
    ];

    render(<StageTimeline stages={stages} currentStage="implement" />);

    // The completed stage should display "✓"
    const planStage = screen.getByText("plan").closest("div")!;
    expect(planStage.textContent).toContain("✓");
  });

  it("highlights the current stage with running style", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "completed" }),
      makeStage({ id: "s2", stageName: "implement", status: "pending" }),
    ];

    render(<StageTimeline stages={stages} currentStage="implement" />);

    // Current stage with pending status gets promoted to "running" visual
    const implementStage = screen.getByText("implement").closest("div")!;
    // Should have the running icon "●"
    expect(implementStage.textContent).toContain("●");
    // Should have blue (running) styling
    expect(implementStage.className).toContain("text-blue-400");
  });

  it("shows pending icon for future stages", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "completed" }),
      makeStage({ id: "s2", stageName: "implement", status: "pending" }),
      makeStage({ id: "s3", stageName: "review", status: "pending" }),
    ];

    render(<StageTimeline stages={stages} currentStage="implement" />);

    // The review stage (not current, still pending) should have "○"
    const reviewStage = screen.getByText("review").closest("div")!;
    expect(reviewStage.textContent).toContain("○");
  });

  it("shows failed icon for failed stages", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "completed" }),
      makeStage({ id: "s2", stageName: "implement", status: "failed" }),
    ];

    render(<StageTimeline stages={stages} currentStage="implement" />);

    const implementStage = screen.getByText("implement").closest("div")!;
    expect(implementStage.textContent).toContain("✕");
  });

  it("shows empty state when no stages are provided", () => {
    render(<StageTimeline stages={[]} currentStage={null} />);

    expect(
      screen.getByText("No stage information available"),
    ).toBeInTheDocument();
  });

  it("shows round number when round > 1", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "implement", round: 2, status: "running" }),
    ];

    render(<StageTimeline stages={stages} currentStage="implement" />);

    expect(screen.getByText("R2")).toBeInTheDocument();
  });

  it("shows model name when set", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "running", model: "gpt-4.1" }),
    ];

    render(<StageTimeline stages={stages} currentStage="plan" />);

    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
  });

  it("applies animate-pulse to the running stage icon", () => {
    const stages = [
      makeStage({ id: "s1", stageName: "plan", status: "completed" }),
      makeStage({ id: "s2", stageName: "implement", status: "pending" }),
    ];

    const { container } = render(
      <StageTimeline stages={stages} currentStage="implement" />,
    );

    // The current pending stage gets promoted to "running" — its icon should pulse
    const pulsingElements = container.querySelectorAll(".animate-pulse");
    expect(pulsingElements.length).toBeGreaterThan(0);
  });
});
