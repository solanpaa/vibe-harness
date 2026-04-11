import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewRunModal } from "../../components/workspace/NewRunModal";
import { useDaemonStore } from "../../stores/daemon";

function makeMockClient() {
  return {
    listProjects: vi.fn().mockResolvedValue({
      projects: [
        { id: "p1", name: "Project Alpha", localPath: "/p1", gitUrl: null, description: null, defaultCredentialSetId: null, createdAt: "", updatedAt: "" },
      ],
    }),
    listWorkflowTemplates: vi.fn().mockResolvedValue({
      templates: [
        { id: "t1", name: "Plan-Implement-Review", description: null, stages: [], isBuiltIn: true, createdAt: "", updatedAt: "" },
      ],
    }),
    listAgents: vi.fn().mockResolvedValue({
      agents: [
        { id: "a1", name: "Copilot CLI", type: "copilot_cli", commandTemplate: "", dockerImage: null, description: null, supportsStreaming: true, supportsContinue: true, supportsIntervention: true, outputFormat: "acp", isBuiltIn: true, createdAt: "" },
      ],
    }),
    listCredentialSets: vi.fn().mockResolvedValue({ sets: [] }),
    getProjectBranches: vi.fn().mockResolvedValue({
      branches: [{ name: "main", isCurrent: true, isRemote: false, lastCommit: null }],
      currentBranch: "main",
    }),
    createRun: vi.fn().mockResolvedValue({ id: "run-new" }),
  };
}

describe("NewRunModal", () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    onClose.mockReset();
    onCreated.mockReset();
    mockClient = makeMockClient();
    useDaemonStore.setState({
      client: mockClient as any,
      connected: true,
      port: 3000,
      lastError: null,
      lastHealthCheck: null,
    });
  });

  it("returns null when not open", () => {
    const { container } = render(
      <NewRunModal open={false} onClose={onClose} onCreated={onCreated} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders form fields when open", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    // Wait for data to load
    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
    });

    expect(screen.getByText("New Run")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Workflow Template")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
  });

  it("has submit button disabled when required fields are empty", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
    });

    const submitBtn = screen.getByText("Create Run");
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit button when all required fields are filled", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
    });

    // Fill in required fields
    const projectSelect = screen.getByText("Project")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(projectSelect, { target: { value: "p1" } });

    const templateSelect = screen.getByText("Workflow Template")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(templateSelect, { target: { value: "t1" } });

    // Agent is auto-selected, but let's be explicit
    const agentSelect = screen.getByText("Agent")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(agentSelect, { target: { value: "a1" } });

    const textarea = screen.getByPlaceholderText(
      "Describe what the agent should do...",
    );
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });

    const submitBtn = screen.getByText("Create Run");
    expect(submitBtn).not.toBeDisabled();
  });

  it("calls onCreated with the run ID on successful submit", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
    });

    // Fill required fields
    const projectSelect = screen.getByText("Project")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(projectSelect, { target: { value: "p1" } });

    const templateSelect = screen.getByText("Workflow Template")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(templateSelect, { target: { value: "t1" } });

    const agentSelect = screen.getByText("Agent")
      .closest("div")!
      .querySelector("select")!;
    fireEvent.change(agentSelect, { target: { value: "a1" } });

    const textarea = screen.getByPlaceholderText(
      "Describe what the agent should do...",
    );
    fireEvent.change(textarea, { target: { value: "Implement feature X" } });

    // Submit
    fireEvent.click(screen.getByText("Create Run"));

    await waitFor(() => {
      expect(mockClient.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          workflowTemplateId: "t1",
          agentDefinitionId: "a1",
          description: "Implement feature X",
        }),
      );
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("run-new");
    });
  });

  it("calls onClose when close button is clicked", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cancel button is clicked", async () => {
    render(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
