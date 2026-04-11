import { useState, useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import type {
  WorkflowTemplate,
  WorkflowStage,
  CreateWorkflowTemplateRequest,
  UpdateWorkflowTemplateRequest,
} from "@vibe-harness/shared";

// ─── Types ──────────────────────────────────────────────────────────────

type View = "list" | "detail" | "create";

const EMPTY_STAGE: WorkflowStage = {
  name: "",
  type: "standard",
  promptTemplate: "",
  reviewRequired: true,
  autoAdvance: false,
  freshSession: false,
};

// ─── Stage Pipeline (visual display) ────────────────────────────────────

function StagePipeline({ stages }: { stages: WorkflowStage[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {stages.map((stage, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground whitespace-nowrap">
            {stage.name || `Stage ${i + 1}`}
            {stage.type === "split" && (
              <span className="ml-1 text-amber-400" title="Split stage">⑂</span>
            )}
            {stage.reviewRequired && (
              <span className="ml-1 text-primary" title="Review gate">◉</span>
            )}
          </span>
          {i < stages.length - 1 && (
            <span className="text-muted-foreground">→</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Stage Editor ───────────────────────────────────────────────────────

function StageEditor({
  stages,
  onChange,
}: {
  stages: WorkflowStage[];
  onChange: (stages: WorkflowStage[]) => void;
}) {
  const update = (idx: number, patch: Partial<WorkflowStage>) => {
    const next = stages.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (idx: number) => {
    onChange(stages.filter((_, i) => i !== idx));
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...stages];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (idx: number) => {
    if (idx >= stages.length - 1) return;
    const next = [...stages];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  };

  const add = () => {
    onChange([...stages, { ...EMPTY_STAGE }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-foreground">
          Stages ({stages.length})
        </label>
        <button
          type="button"
          onClick={add}
          className="px-2 py-1 text-xs rounded-md bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          + Add Stage
        </button>
      </div>

      {stages.length > 0 && (
        <StagePipeline stages={stages} />
      )}

      {stages.map((stage, idx) => (
        <div key={idx} className="border border-border rounded-lg p-3 space-y-2 bg-card">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Stage {idx + 1}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => moveUp(idx)}
                disabled={idx === 0}
                className="px-1.5 py-0.5 text-xs rounded bg-muted hover:bg-accent disabled:opacity-30 text-muted-foreground"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveDown(idx)}
                disabled={idx >= stages.length - 1}
                className="px-1.5 py-0.5 text-xs rounded bg-muted hover:bg-accent disabled:opacity-30 text-muted-foreground"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted-foreground mb-0.5">Name</label>
              <input
                type="text"
                value={stage.name}
                onChange={(e) => update(idx, { name: e.target.value })}
                placeholder="e.g. plan"
                className="w-full px-2 py-1 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-0.5">Type</label>
              <select
                value={stage.type}
                onChange={(e) => update(idx, { type: e.target.value as "standard" | "split" })}
                className="w-full px-2 py-1 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none"
              >
                <option value="standard">Standard</option>
                <option value="split">Split</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-0.5">Prompt Template</label>
            <textarea
              value={stage.promptTemplate}
              onChange={(e) => update(idx, { promptTemplate: e.target.value })}
              placeholder="Instructions for this stage..."
              rows={3}
              className="w-full px-2 py-1 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none resize-y"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5 text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={stage.reviewRequired}
                onChange={(e) =>
                  update(idx, {
                    reviewRequired: e.target.checked,
                    autoAdvance: e.target.checked ? false : stage.autoAdvance,
                  })
                }
                className="rounded bg-background border-border"
              />
              Review required
            </label>
            <label className="flex items-center gap-1.5 text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={stage.autoAdvance}
                onChange={(e) =>
                  update(idx, {
                    autoAdvance: e.target.checked,
                    reviewRequired: e.target.checked ? false : stage.reviewRequired,
                  })
                }
                className="rounded bg-background border-border"
              />
              Auto advance
            </label>
            <label className="flex items-center gap-1.5 text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={stage.freshSession}
                onChange={(e) => update(idx, { freshSession: e.target.checked })}
                className="rounded bg-background border-border"
              />
              Fresh session
            </label>
            <div className="flex items-center gap-1.5">
              <label className="text-muted-foreground text-xs">Model</label>
              <input
                type="text"
                value={stage.model ?? ""}
                onChange={(e) => update(idx, { model: e.target.value || undefined })}
                placeholder="(default)"
                className="w-28 px-2 py-0.5 text-xs rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none"
              />
            </div>
          </div>
        </div>
      ))}

      {stages.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-4">
          No stages yet. Add at least one stage.
        </p>
      )}
    </div>
  );
}

// ─── Template Form ──────────────────────────────────────────────────────

function TemplateForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: WorkflowTemplate;
  onSubmit: (data: CreateWorkflowTemplateRequest | UpdateWorkflowTemplateRequest) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [stages, setStages] = useState<WorkflowStage[]>(
    initial?.stages ?? [{ ...EMPTY_STAGE }]
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (stages.length === 0) {
      setError("At least one stage is required");
      return;
    }
    for (const [i, s] of stages.entries()) {
      if (!s.name.trim()) {
        setError(`Stage ${i + 1}: name is required`);
        return;
      }
      if (!s.promptTemplate.trim()) {
        setError(`Stage ${i + 1}: prompt template is required`);
        return;
      }
      if (s.reviewRequired && s.autoAdvance) {
        setError(`Stage ${i + 1}: reviewRequired and autoAdvance are mutually exclusive`);
        return;
      }
    }

    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        stages,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-3xl">
      {error && (
        <div className="px-3 py-2 rounded bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Plan & Implement"
          className="w-full px-3 py-1.5 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full px-3 py-1.5 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <StageEditor stages={stages} onChange={setStages} />

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-md bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Saving..." : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-md bg-muted hover:bg-accent text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Template Detail / Edit ─────────────────────────────────────────────

function TemplateDetail({
  template,
  onBack,
  onUpdated,
  onDeleted,
}: {
  template: WorkflowTemplate;
  onBack: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const { client } = useDaemonStore();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpdate = async (data: CreateWorkflowTemplateRequest | UpdateWorkflowTemplateRequest) => {
    if (!client) return;
    await client.updateWorkflowTemplate(template.id, data);
    setEditing(false);
    onUpdated();
  };

  const handleDelete = async () => {
    if (!client) return;
    setError(null);
    setDeleting(true);
    try {
      await client.deleteWorkflowTemplate(template.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  if (editing) {
    return (
      <div>
        <h2 className="text-sm font-medium text-foreground mb-4">Edit Template</h2>
        <TemplateForm
          initial={template}
          onSubmit={handleUpdate}
          onCancel={() => setEditing(false)}
          submitLabel="Save Changes"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-accent text-muted-foreground"
        >
          ← Back
        </button>
        <h2 className="text-sm font-medium text-foreground">{template.name}</h2>
        {template.isBuiltIn && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Built-in
          </span>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          {error}
        </div>
      )}

      {template.description && (
        <p className="text-sm text-muted-foreground">{template.description}</p>
      )}

      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Pipeline</h3>
        <StagePipeline stages={template.stages} />
      </div>

      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Stages</h3>
        <div className="space-y-2">
          {template.stages.map((stage, i) => (
            <div key={i} className="border border-border rounded-lg p-3 bg-card">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-foreground">{stage.name}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {stage.type}
                </span>
                {stage.reviewRequired && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    review
                  </span>
                )}
                {stage.autoAdvance && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    auto-advance
                  </span>
                )}
                {stage.freshSession && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    fresh
                  </span>
                )}
                {stage.model && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {stage.model}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                {stage.promptTemplate}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <button
          onClick={() => setEditing(true)}
          disabled={template.isBuiltIn}
          className="px-3 py-1.5 text-sm rounded-md bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          title={template.isBuiltIn ? "Cannot edit built-in templates" : ""}
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          disabled={template.isBuiltIn || deleting}
          className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={template.isBuiltIn ? "Cannot delete built-in templates" : ""}
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          Created {new Date(template.createdAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}

// ─── Main Workflows Page ────────────────────────────────────────────────

export function Workflows() {
  const { client, connected } = useDaemonStore();
  const [view, setView] = useState<View>("list");
  const [templates, setTemplates] = useState<(WorkflowTemplate & { stageCount?: number })[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.listWorkflowTemplates();
      setTemplates(res.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (connected) loadTemplates();
  }, [connected, loadTemplates]);

  const selectedTemplate = templates.find((t) => t.id === selectedId);

  // ── Create view ───────────────────────────────────────────────────

  if (view === "create") {
    const handleCreate = async (data: CreateWorkflowTemplateRequest | UpdateWorkflowTemplateRequest) => {
      if (!client) return;
      const created = await client.createWorkflowTemplate(data as CreateWorkflowTemplateRequest);
      await loadTemplates();
      setSelectedId(created.id);
      setView("detail");
    };

    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-sm font-medium text-foreground mb-6">Create Workflow Template</h1>
        <TemplateForm
          onSubmit={handleCreate}
          onCancel={() => setView("list")}
          submitLabel="Create Template"
        />
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────

  if (view === "detail" && selectedTemplate) {
    return (
      <div className="p-6 max-w-4xl">
        <TemplateDetail
          template={selectedTemplate}
          onBack={() => {
            setView("list");
            setSelectedId(null);
          }}
          onUpdated={loadTemplates}
          onDeleted={() => {
            setSelectedId(null);
            setView("list");
            loadTemplates();
          }}
        />
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-sm font-medium text-foreground mb-4">Workflows</h1>
        <p className="text-muted-foreground">Daemon not connected.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm font-medium text-foreground">Workflow Templates</h1>
        <button
          onClick={() => setView("create")}
          className="text-sm px-3 py-1.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          + Create Template
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 mb-3 rounded bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : templates.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No workflow templates found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelectedId(t.id);
                setView("detail");
              }}
              className="w-full text-left px-4 py-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-foreground">{t.name}</span>
                {t.isBuiltIn && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    Built-in
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {t.stages.length} stage{t.stages.length !== 1 ? "s" : ""}
                </span>
              </div>
              {t.description && (
                <p className="text-xs text-muted-foreground mb-1.5">{t.description}</p>
              )}
              <StagePipeline stages={t.stages} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
