import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

        // Auto-select when only one option
        if (projRes.projects.length === 1 && !projectId) {
          setProjectId(projRes.projects[0].id);
        }
        if (tmplRes.templates.length > 0 && !workflowTemplateId) {
          setWorkflowTemplateId(tmplRes.templates[0].id);
        }
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
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h2 className="text-lg font-semibold text-foreground">New Run</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Project (required) */}
          <FormField label="Project" required>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select project...">
                  {projects.find(p => p.id === projectId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Workflow template (required) */}
          <FormField label="Workflow Template" required>
            <Select value={workflowTemplateId} onValueChange={setWorkflowTemplateId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select template...">
                  {templates.find(t => t.id === workflowTemplateId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Agent (required) */}
          <FormField label="Agent" required>
            <Select value={agentDefinitionId} onValueChange={setAgentDefinitionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select agent...">
                  {agents.find(a => a.id === agentDefinitionId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Description / prompt (required) */}
          <FormField label="Description" required>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what the agent should do..."
              rows={4}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/50 resize-none"
            />
          </FormField>

          {/* Optional fields */}
          <details className="group">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors py-1">
              Advanced options ▸
            </summary>
            <div className="mt-3 space-y-4">
              {/* Base branch */}
              <FormField label="Base Branch">
                <Select
                  value={baseBranch || "default"}
                  onValueChange={(v) => setBaseBranch(v === "default" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Default branch" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default branch</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {/* Target branch */}
              <FormField label="Target Branch">
                <input
                  type="text"
                  value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)}
                  placeholder="Auto-generated if empty"
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/50"
                />
              </FormField>

              {/* Credential set */}
              <FormField label="Credential Set">
                <Select
                  value={credentialSetId || "none"}
                  onValueChange={(v) => setCredentialSetId(v === "none" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {credentials.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {/* Model override */}
              <FormField label="Model Override">
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4.1, claude-sonnet-4.5"
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/50"
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
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground transition-colors"
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
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
