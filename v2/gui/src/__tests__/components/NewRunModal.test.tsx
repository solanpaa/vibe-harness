import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { NewRunModal } from "../../components/workspace/NewRunModal";
import { useDaemonStore } from "../../stores/daemon";

// react-router's useNavigate requires a Router ancestor. Wrap once here so
// the individual tests stay focused on NewRunModal behaviour.
function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

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
    listGhAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
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
    const { container } = renderWithRouter(
      <NewRunModal open={false} onClose={onClose} onCreated={onCreated} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders form fields when open", async () => {
    renderWithRouter(
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
    renderWithRouter(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
    });

    const submitBtn = screen.getByText("Create Run");
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit button when all required fields are filled", async () => {
    renderWithRouter(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    // Project, template, and agent are auto-selected when only one option exists.
    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
      expect(mockClient.listAgents).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText(
      "Describe what the agent should do...",
    );
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });

    await waitFor(() => {
      const submitBtn = screen.getByText("Create Run");
      expect(submitBtn).not.toBeDisabled();
    });
  });

  it("calls onCreated with the run ID on successful submit", async () => {
    renderWithRouter(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    await waitFor(() => {
      expect(mockClient.listProjects).toHaveBeenCalled();
      expect(mockClient.listAgents).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText(
      "Describe what the agent should do...",
    );
    fireEvent.change(textarea, { target: { value: "Implement feature X" } });

    await waitFor(() => {
      expect(screen.getByText("Create Run")).not.toBeDisabled();
    });

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
    renderWithRouter(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cancel button is clicked", async () => {
    renderWithRouter(
      <NewRunModal open={true} onClose={onClose} onCreated={onCreated} />,
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
