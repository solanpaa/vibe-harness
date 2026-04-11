import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import type {
  ProjectListResponse,
  WorkflowTemplateListResponse,
  AgentDefinitionListResponse,
  CredentialSetListResponse,
  CreateWorkflowRunRequest,
} from "@vibe-harness/shared";

interface NewRunModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunModal({ open, onClose, onCreated }: NewRunModalProps) {
  const { client } = useDaemonStore();

  // Form state
  const [projectId, setProjectId] = useState("");
  const [workflowTemplateId, setWorkflowTemplateId] = useState("");
  const [agentDefinitionId, setAgentDefinitionId] = useState("");
  const [description, setDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [credentialSetId, setCredentialSetId] = useState("");
  const [model, setModel] = useState("");

  // Data
  const [projects, setProjects] = useState<ProjectListResponse["projects"]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplateListResponse["templates"]>([]);
  const [agents, setAgents] = useState<AgentDefinitionListResponse["agents"]>([]);
  const [credentials, setCredentials] = useState<CredentialSetListResponse["sets"]>([]);
  const [branches, setBranches] = useState<string[]>([]);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial data
  useEffect(() => {
    if (!open || !client) return;

    Promise.all([
      client.listProjects(),
      client.listWorkflowTemplates(),
      client.listAgents(),
      client.listCredentialSets(),
    ])
      .then(([projRes, tmplRes, agentRes, credRes]) => {
        setProjects(projRes.projects);
        setTemplates(tmplRes.templates);
        setAgents(agentRes.agents);
        setCredentials(credRes.sets);

        // Auto-select first agent if available
        if (agentRes.agents.length > 0 && !agentDefinitionId) {
          setAgentDefinitionId(agentRes.agents[0].id);
        }
      })
      .catch((err) =>
        console.error("Failed to load modal data:", err),
      );
  }, [open, client]);

  // Fetch branches when project changes
  useEffect(() => {
    if (!projectId || !client) {
      setBranches([]);
      return;
    }

    client
      .getProjectBranches(projectId)
      .then((res) => {
        setBranches(res.branches.map((b) => b.name));
        // Auto-set base branch to current
        const current = res.branches.find((b) => b.isCurrent);
        if (current && !baseBranch) {
          setBaseBranch(current.name);
        }
      })
      .catch(() => setBranches([]));
  }, [projectId, client]);

  const handleSubmit = useCallback(async () => {
    if (!client || !projectId || !workflowTemplateId || !agentDefinitionId || !description.trim()) {
      setError("Please fill in all required fields");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const req: CreateWorkflowRunRequest = {
        projectId,
        workflowTemplateId,
        agentDefinitionId,
        description: description.trim(),
        ...(baseBranch ? { baseBranch } : {}),
        ...(targetBranch ? { targetBranch } : {}),
        ...(credentialSetId ? { credentialSetId } : {}),
        ...(model ? { model } : {}),
      };

      const res = await client.createRun(req);
      onCreated(res.id);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    } finally {
      setSubmitting(false);
    }
  }, [
    client, projectId, workflowTemplateId, agentDefinitionId,
    description, baseBranch, targetBranch, credentialSetId, model, onCreated,
  ]);

  const resetForm = () => {
    setDescription("");
    setBaseBranch("");
    setTargetBranch("");
    setModel("");
    setError(null);
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700/50">
          <h2 className="text-lg font-semibold text-zinc-100">New Run</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Project (required) */}
          <FormField label="Project" required>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FormField>

          {/* Workflow template (required) */}
          <FormField label="Workflow Template" required>
            <select
              value={workflowTemplateId}
              onChange={(e) => setWorkflowTemplateId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              <option value="">Select template...</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FormField>

          {/* Agent (required) */}
          <FormField label="Agent" required>
            <select
              value={agentDefinitionId}
              onChange={(e) => setAgentDefinitionId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              <option value="">Select agent...</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>

          {/* Description / prompt (required) */}
          <FormField label="Description" required>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what the agent should do..."
              rows={4}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 resize-none"
            />
          </FormField>

          {/* Optional fields */}
          <details className="group">
            <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400 transition-colors py-1">
              Advanced options ▸
            </summary>
            <div className="mt-3 space-y-4">
              {/* Base branch */}
              <FormField label="Base Branch">
                <select
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                >
                  <option value="">Default branch</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </FormField>

              {/* Target branch */}
              <FormField label="Target Branch">
                <input
                  type="text"
                  value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)}
                  placeholder="Auto-generated if empty"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                />
              </FormField>

              {/* Credential set */}
              <FormField label="Credential Set">
                <select
                  value={credentialSetId}
                  onChange={(e) => setCredentialSetId(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                >
                  <option value="">None</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </FormField>

              {/* Model override */}
              <FormField label="Model Override">
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4.1, claude-sonnet-4.5"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                />
              </FormField>
            </div>
          </details>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-400 bg-red-950/30 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-700/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !projectId || !workflowTemplateId || !agentDefinitionId || !description.trim()}
            className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Creating..." : "Create Run"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
