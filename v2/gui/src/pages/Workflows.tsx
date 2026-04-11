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
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-700 text-zinc-200 whitespace-nowrap">
            {stage.name || `Stage ${i + 1}`}
            {stage.type === "split" && (
              <span className="ml-1 text-amber-400" title="Split stage">⑂</span>
            )}
            {stage.reviewRequired && (
              <span className="ml-1 text-blue-400" title="Review gate">◉</span>
            )}
          </span>
          {i < stages.length - 1 && (
            <span className="text-zinc-500">→</span>
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
        <label className="block text-sm font-medium text-zinc-300">
          Stages ({stages.length})
        </label>
        <button
          type="button"
          onClick={add}
          className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
        >
          + Add Stage
        </button>
      </div>

      {stages.length > 0 && (
        <StagePipeline stages={stages} />
      )}

      {stages.map((stage, idx) => (
        <div key={idx} className="border border-zinc-700 rounded-lg p-3 space-y-2 bg-zinc-800/50">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-300">
              Stage {idx + 1}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => moveUp(idx)}
                disabled={idx === 0}
                className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-zinc-300"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveDown(idx)}
                disabled={idx >= stages.length - 1}
                className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-zinc-300"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="px-1.5 py-0.5 text-xs rounded bg-red-800/60 hover:bg-red-700 text-red-200"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-zinc-400 mb-0.5">Name</label>
              <input
                type="text"
                value={stage.name}
                onChange={(e) => update(idx, { name: e.target.value })}
                placeholder="e.g. plan"
                className="w-full px-2 py-1 text-sm rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-0.5">Type</label>
              <select
                value={stage.type}
                onChange={(e) => update(idx, { type: e.target.value as "standard" | "split" })}
                className="w-full px-2 py-1 text-sm rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none"
              >
                <option value="standard">Standard</option>
                <option value="split">Split</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-0.5">Prompt Template</label>
            <textarea
              value={stage.promptTemplate}
              onChange={(e) => update(idx, { promptTemplate: e.target.value })}
              placeholder="Instructions for this stage..."
              rows={3}
              className="w-full px-2 py-1 text-sm rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none resize-y"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={stage.reviewRequired}
                onChange={(e) =>
                  update(idx, {
                    reviewRequired: e.target.checked,
                    autoAdvance: e.target.checked ? false : stage.autoAdvance,
                  })
                }
                className="rounded bg-zinc-900 border-zinc-600"
              />
              Review required
            </label>
            <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={stage.autoAdvance}
                onChange={(e) =>
                  update(idx, {
                    autoAdvance: e.target.checked,
                    reviewRequired: e.target.checked ? false : stage.reviewRequired,
                  })
                }
                className="rounded bg-zinc-900 border-zinc-600"
              />
              Auto advance
            </label>
            <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={stage.freshSession}
                onChange={(e) => update(idx, { freshSession: e.target.checked })}
                className="rounded bg-zinc-900 border-zinc-600"
              />
              Fresh session
            </label>
            <div className="flex items-center gap-1.5">
              <label className="text-zinc-400 text-xs">Model</label>
              <input
                type="text"
                value={stage.model ?? ""}
                onChange={(e) => update(idx, { model: e.target.value || undefined })}
                placeholder="(default)"
                className="w-28 px-2 py-0.5 text-xs rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
      ))}

      {stages.length === 0 && (
        <p className="text-zinc-500 text-sm text-center py-4">
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
        <div className="px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Plan & Implement"
          className="w-full px-3 py-1.5 text-sm rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full px-3 py-1.5 text-sm rounded bg-zinc-900 border border-zinc-700 text-zinc-200 focus:border-blue-500 focus:outline-none"
        />
      </div>

      <StageEditor stages={stages} onChange={setStages} />

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-sm rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
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
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">Edit Template</h2>
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
          className="px-2 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold text-zinc-200">{template.name}</h2>
        {template.isBuiltIn && (
          <span className="px-1.5 py-0.5 text-xs rounded bg-amber-800/50 text-amber-300">
            Built-in
          </span>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      {template.description && (
        <p className="text-sm text-zinc-400">{template.description}</p>
      )}

      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Pipeline</h3>
        <StagePipeline stages={template.stages} />
      </div>

      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Stages</h3>
        <div className="space-y-2">
          {template.stages.map((stage, i) => (
            <div key={i} className="border border-zinc-700 rounded-lg p-3 bg-zinc-800/50">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-zinc-200">{stage.name}</span>
                <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 text-zinc-400">
                  {stage.type}
                </span>
                {stage.reviewRequired && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-blue-900/40 text-blue-300">
                    review
                  </span>
                )}
                {stage.autoAdvance && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-green-900/40 text-green-300">
                    auto-advance
                  </span>
                )}
                {stage.freshSession && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-purple-900/40 text-purple-300">
                    fresh
                  </span>
                )}
                {stage.model && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 text-zinc-400">
                    {stage.model}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500 whitespace-pre-wrap font-mono">
                {stage.promptTemplate}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
        <button
          onClick={() => setEditing(true)}
          disabled={template.isBuiltIn}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          title={template.isBuiltIn ? "Cannot edit built-in templates" : ""}
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          disabled={template.isBuiltIn || deleting}
          className="px-3 py-1.5 text-sm rounded bg-red-800/60 hover:bg-red-700 text-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title={template.isBuiltIn ? "Cannot delete built-in templates" : ""}
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
        <span className="ml-auto text-xs text-zinc-500">
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
      <div>
        <h1 className="text-xl font-semibold text-zinc-200 mb-4">Create Workflow Template</h1>
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
      <div>
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
      <div>
        <h1 className="text-xl font-semibold text-zinc-200 mb-4">Workflows</h1>
        <p className="text-zinc-500">Daemon not connected.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-zinc-200">Workflow Templates</h1>
        <button
          onClick={() => setView("create")}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white"
        >
          + Create Template
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 mb-3 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-zinc-500 text-sm">Loading...</p>
      ) : templates.length === 0 ? (
        <p className="text-zinc-500 text-sm">No workflow templates found.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelectedId(t.id);
                setView("detail");
              }}
              className="w-full text-left px-4 py-3 rounded-lg border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-zinc-200">{t.name}</span>
                {t.isBuiltIn && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-amber-800/50 text-amber-300">
                    Built-in
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                  {t.stages.length} stage{t.stages.length !== 1 ? "s" : ""}
                </span>
              </div>
              {t.description && (
                <p className="text-xs text-zinc-400 mb-1.5">{t.description}</p>
              )}
              <StagePipeline stages={t.stages} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
