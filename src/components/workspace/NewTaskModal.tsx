"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Workflow, ArrowRight, GitFork, GitBranch, Loader2, GitCompare, Plus, X } from "lucide-react";
import { toast } from "sonner";

// ── Types ────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
  type: string;
}

interface CredentialSet {
  id: string;
  name: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string | null;
  stages: Array<{
    name: string;
    type?: string;
    promptTemplate: string;
    reviewRequired: boolean;
  }>;
}

interface FormState {
  projectId: string;
  agentDefinitionId: string;
  credentialSetId: string;
  model: string;
  useWorktree: boolean;
  workflowTemplateId: string;
  prompt: string;
  branch: string;
}

interface CompareVariant {
  agentDefinitionId: string;
  model: string;
  label: string;
}

// ── Props ────────────────────────────────────────────────────────────

export interface NewTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string;
  onTaskCreated?: (taskId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

const DIRECT_EXECUTE_ID = "00000000-0000-0000-0000-000000000012";

const INITIAL_FORM: FormState = {
  projectId: "",
  agentDefinitionId: "",
  credentialSetId: "",
  model: "",
  useWorktree: true,
  workflowTemplateId: DIRECT_EXECUTE_ID,
  prompt: "",
  branch: "",
};

// ── Component ────────────────────────────────────────────────────────

export function NewTaskModal({
  open,
  onOpenChange,
  defaultProjectId,
  onTaskCreated,
}: NewTaskModalProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [credSets, setCredSets] = useState<CredentialSet[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [compareMode, setCompareMode] = useState(false);
  const [variants, setVariants] = useState<CompareVariant[]>([
    { agentDefinitionId: "", model: "", label: "" },
    { agentDefinitionId: "", model: "", label: "" },
  ]);

  // ── Data loading ─────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/agents").then((r) => r.json()),
      fetch("/api/credentials").then((r) => r.json()),
      fetch("/api/workflows").then((r) => r.json()),
      fetch("/api/last-run-config").then((r) => r.json()).catch(() => null),
    ])
      .then(([p, a, c, w, lastConfig]) => {
        setProjects(p);
        setAgents(a);
        setCredSets(c);
        setWorkflows(w);

        // Apply last run config as defaults (prompt always stays empty)
        if (lastConfig) {
          setForm((f) => ({
            ...f,
            projectId:
              defaultProjectId ??
              (p.some((proj: { id: string }) => proj.id === lastConfig.projectId)
                ? lastConfig.projectId
                : f.projectId),
            agentDefinitionId:
              a.some((ag: { id: string }) => ag.id === lastConfig.agentDefinitionId)
                ? lastConfig.agentDefinitionId
                : a[0]?.id ?? f.agentDefinitionId,
            credentialSetId:
              c.some((cs: { id: string }) => cs.id === lastConfig.credentialSetId)
                ? lastConfig.credentialSetId
                : "",
            model: lastConfig.model ?? "",
            useWorktree: lastConfig.useWorktree != null ? !!lastConfig.useWorktree : true,
            workflowTemplateId:
              w.some((wf: { id: string }) => wf.id === lastConfig.workflowTemplateId)
                ? lastConfig.workflowTemplateId
                : DIRECT_EXECUTE_ID,
          }));
        }
      })
      .catch(() => {
        toast.error("Failed to load form data");
      });
  }, [open, defaultProjectId]);

  // Fetch branches when project changes
  useEffect(() => {
    if (!form.projectId) {
      setBranches({ branches: [], current: "" });
      setForm((f) => ({ ...f, branch: "" }));
      return;
    }
    fetch(`/api/projects/${form.projectId}/branches`)
      .then((r) => r.json())
      .then((data) => {
        setBranches(data);
        setForm((f) => ({ ...f, branch: data.current || "" }));
      })
      .catch(() => {
        setBranches({ branches: [], current: "" });
      });
  }, [form.projectId]);

  // ── Derived state ────────────────────────────────────────────────

  const selectedWorkflow = workflows.find(
    (w) => w.id === form.workflowTemplateId
  );
  const isCompareMode = compareMode;
  const canSubmitBase =
    !!form.projectId && !!form.prompt.trim() && !!form.workflowTemplateId;
  const canSubmitSingle = canSubmitBase && !!form.agentDefinitionId;
  const canSubmitCompare = canSubmitBase && variants.filter((v) => v.agentDefinitionId).length >= 2;
  const canSubmit = isCompareMode ? canSubmitCompare : canSubmitSingle;

  // ── Form helpers ─────────────────────────────────────────────────

  function saveLastRunConfig() {
    fetch("/api/last-run-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: form.projectId || null,
        agentDefinitionId: form.agentDefinitionId || null,
        credentialSetId: form.credentialSetId || null,
        model: form.model.trim() || null,
        useWorktree: form.useWorktree,
        workflowTemplateId: form.workflowTemplateId || null,
      }),
    }).catch(() => {});
  }

  function resetForm() {
    setForm({
      ...INITIAL_FORM,
      projectId: defaultProjectId ?? "",
      agentDefinitionId: agents[0]?.id ?? "",
      workflowTemplateId: DIRECT_EXECUTE_ID,
      branch: "",
    });
    setCompareMode(false);
    setVariants([
      { agentDefinitionId: agents[0]?.id ?? "", model: "", label: "" },
      { agentDefinitionId: agents[1]?.id ?? agents[0]?.id ?? "", model: "", label: "" },
    ]);
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // ── Submit ───────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!canSubmit) {
      toast.error("Please fill in all required fields");
      return;
    }

    setLoading(true);
    try {
      if (isCompareMode) {
        // Compare mode: POST to /api/comparisons
        const validVariants = variants
          .filter((v) => v.agentDefinitionId)
          .map((v) => ({
            agentDefinitionId: v.agentDefinitionId,
            model: v.model.trim() || null,
            label: v.label.trim() || undefined,
          }));

        const res = await fetch("/api/comparisons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: form.projectId,
            prompt: form.prompt,
            credentialSetId: form.credentialSetId || null,
            useWorktree: form.useWorktree,
            branch: form.branch || null,
            variants: validVariants,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          toast.error(body?.error ?? "Failed to start comparison");
          return;
        }
        const result = await res.json();
        toast.success(`Comparison started with ${result.tasks.length} variants`);
        saveLastRunConfig();
        onOpenChange(false);
        resetForm();
        onTaskCreated?.(result.tasks[0]?.taskId);
      } else {
        // All tasks go through workflow runs
        const res = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start_run",
            workflowTemplateId: form.workflowTemplateId,
            projectId: form.projectId,
            taskDescription: form.prompt,
            agentDefinitionId: form.agentDefinitionId,
            credentialSetId: form.credentialSetId || null,
            model: form.model.trim() || null,
            useWorktree: form.useWorktree,
            branch: form.branch || null,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          toast.error(body?.error ?? "Failed to start workflow");
          return;
        }
        const result = await res.json();
        toast.success(`Workflow started — stage: ${result.stageName}`);
        saveLastRunConfig();
        onOpenChange(false);
        resetForm();
        onTaskCreated?.(result.taskId);
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Launch Agent Task</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Project */}
          <div className="space-y-2">
            <Label>Project *</Label>
            <Select
              value={form.projectId}
              onValueChange={(v) => update("projectId", v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a project...">
                  {projects.find((p) => p.id === form.projectId)?.name}
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
          </div>

          {/* Compare Mode Toggle */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="newTaskCompareMode"
              checked={compareMode}
              onChange={(e) => setCompareMode(e.target.checked)}
            />
            <Label htmlFor="newTaskCompareMode" className="flex items-center gap-1">
              <GitCompare className="h-3 w-3" />
              Compare Agents
            </Label>
            {compareMode && (
              <span className="text-[11px] text-muted-foreground">
                Run same task with multiple agents
              </span>
            )}
          </div>

          {/* Agent (single mode) */}
          {!isCompareMode && (
          <div className="space-y-2">
            <Label>Agent *</Label>
            <Select
              value={form.agentDefinitionId}
              onValueChange={(v) => update("agentDefinitionId", v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an agent...">
                  {(() => {
                    const a = agents.find(
                      (a) => a.id === form.agentDefinitionId
                    );
                    return a ? `${a.name}` : undefined;
                  })()}
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
          </div>
          )}

          {/* Compare Variants */}
          {isCompareMode && (
            <div className="space-y-3">
              <Label>Agent Variants (min 2, max 5)</Label>
              {variants.map((variant, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-md border p-2">
                  <span className="mt-2.5 text-[11px] font-semibold text-muted-foreground w-4 shrink-0">
                    {idx + 1}
                  </span>
                  <div className="flex-1 space-y-2">
                    <Select
                      value={variant.agentDefinitionId || "none"}
                      onValueChange={(v) => {
                        const next = [...variants];
                        next[idx] = { ...next[idx], agentDefinitionId: v === "none" ? "" : (v ?? "") };
                        setVariants(next);
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Select agent...">
                          {agents.find((a) => a.id === variant.agentDefinitionId)?.name ?? "Select agent..."}
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
                    <Input
                      value={variant.model}
                      onChange={(e) => {
                        const next = [...variants];
                        next[idx] = { ...next[idx], model: e.target.value };
                        setVariants(next);
                      }}
                      placeholder="Model (e.g. claude-opus-4.6)"
                      className="h-8"
                    />
                  </div>
                  {variants.length > 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 mt-0.5"
                      onClick={() => setVariants(variants.filter((_, i) => i !== idx))}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
              {variants.length < 5 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setVariants([
                      ...variants,
                      { agentDefinitionId: agents[0]?.id ?? "", model: "", label: "" },
                    ])
                  }
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add Variant
                </Button>
              )}
            </div>
          )}

          {/* Model (single mode only) */}
          {!isCompareMode && (
          <div className="space-y-2">
            <Label>Model (optional)</Label>
            <Input
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="claude-opus-4.6"
            />
          </div>
          )}

          {/* Credential Set */}
          <div className="space-y-2">
            <Label>Credential Set (optional)</Label>
            <Select
              value={form.credentialSetId || "none"}
              onValueChange={(v) =>
                update("credentialSetId", v === "none" ? "" : (v ?? ""))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="None">
                  {credSets.find((c) => c.id === form.credentialSetId)?.name ??
                    "None"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {credSets.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Workflow */}
          <div className="space-y-2">
            <Label>Workflow</Label>
            <Select
              value={form.workflowTemplateId}
              onValueChange={(v) =>
                update("workflowTemplateId", v ?? DIRECT_EXECUTE_ID)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select workflow">
                  {selectedWorkflow?.name ?? "Select workflow"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {workflows.map((w) => {
                  const hasSplit = w.stages.some((s) => s.type === "split");
                  return (
                    <SelectItem key={w.id} value={w.id}>
                      <div className="flex items-center gap-2">
                        {hasSplit ? (
                          <GitFork className="h-3 w-3 text-indigo-500" />
                        ) : (
                          <Workflow className="h-3 w-3" />
                        )}
                        {w.name} ({w.stages.length} stage{w.stages.length !== 1 ? "s" : ""})
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {selectedWorkflow && (
              <>
                <div className="flex items-center gap-1 flex-wrap text-xs text-muted-foreground mt-1">
                  {selectedWorkflow.stages.map((stage, i) => {
                    const isSplit = stage.type === "split";
                    return (
                      <span key={stage.name} className="flex items-center gap-1">
                        <Badge
                          variant="secondary"
                          className={`text-[10px] px-1.5 py-0 ${isSplit ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300" : ""}`}
                        >
                          {isSplit && <GitFork className="mr-0.5 h-2.5 w-2.5" />}
                          {stage.name}
                        </Badge>
                        {i < selectedWorkflow.stages.length - 1 && (
                          <ArrowRight className="h-3 w-3" />
                        )}
                      </span>
                    );
                  })}
                </div>
                {selectedWorkflow.description && (
                  <p className="text-xs text-muted-foreground">
                    {selectedWorkflow.description}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Use Git Worktree */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="newTaskUseWorktree"
              checked={form.useWorktree}
              onChange={(e) => update("useWorktree", e.target.checked)}
            />
            <Label htmlFor="newTaskUseWorktree">
              Use Git Worktree (isolated copy of the repo)
            </Label>
          </div>

          {/* Branch */}
          {form.useWorktree && branches.branches.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                Base Branch
              </Label>
              <Select
                value={form.branch}
                onValueChange={(v) => update("branch", v ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select branch...">
                    {form.branch || branches.current || "Select branch..."}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {branches.branches.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}{b === branches.current ? " (current)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Task Description */}
          <div className="space-y-2">
            <Label>Task Description *</Label>
            <Textarea
              value={form.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              placeholder="Describe the feature or task to implement..."
              className="min-h-[120px]"
              required
            />
          </div>

          {/* Submit */}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || !canSubmit}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Launching...
              </>
            ) : isCompareMode ? (
              <>
                <GitCompare className="mr-2 h-4 w-4" />
                Compare {variants.filter((v) => v.agentDefinitionId).length} Variants
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Launch
              </>
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
