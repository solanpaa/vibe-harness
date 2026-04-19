import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../components/shared/StatusBadge";
import type { WorkflowRunStatus } from "@vibe-harness/shared";

describe("StatusBadge", () => {
  const knownStatuses: { status: WorkflowRunStatus; label: string }[] = [
    { status: "pending", label: "Pending" },
    { status: "provisioning", label: "Provisioning" },
    { status: "running", label: "Running" },
    { status: "stage_failed", label: "Stage Failed" },
    { status: "awaiting_review", label: "Awaiting Review" },
    { status: "awaiting_proposals", label: "Awaiting Proposals" },
    { status: "waiting_for_children", label: "Waiting" },
    { status: "children_completed_with_failures", label: "Partial Fail" },
    { status: "awaiting_conflict_resolution", label: "Conflict" },
    { status: "finalizing", label: "Finalizing" },
    { status: "completed", label: "Completed" },
    { status: "failed", label: "Failed" },
    { status: "cancelled", label: "Cancelled" },
  ];

  it.each(knownStatuses)(
    "renders correct label for $status",
    ({ status, label }) => {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it("falls back to the raw status string for unknown statuses", () => {
    render(<StatusBadge status={"totally_new" as WorkflowRunStatus} />);
    expect(screen.getByText("totally_new")).toBeInTheDocument();
  });

  it("hides label when showLabel is false", () => {
    render(<StatusBadge status="running" showLabel={false} />);
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });

  const animatedStatuses = ["running", "provisioning", "finalizing", "waiting_for_children"];

  it.each(animatedStatuses)(
    "shows animated dot for active status %s",
    (status) => {
      const { container } = render(
        <StatusBadge status={status as WorkflowRunStatus} />,
      );
      const dot = container.querySelector(".animate-pulse");
      expect(dot).toBeInTheDocument();
    },
  );

  const terminalStatuses = ["completed", "failed", "cancelled"];

  it.each(terminalStatuses)(
    "does not show animated dot for terminal status %s",
    (status) => {
      const { container } = render(
        <StatusBadge status={status as WorkflowRunStatus} />,
      );
      const dot = container.querySelector(".animate-pulse");
      expect(dot).not.toBeInTheDocument();
    },
  );
});
