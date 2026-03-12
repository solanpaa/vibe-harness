"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  CheckCircle,
  CircleDot,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type {
  CredentialSet,
  Project,
  WorkflowRun,
  WorkflowStage,
  WorkflowTemplate,
} from "@/types/domain";

/* ------------------------------------------------------------------ */
/*  Status badge config                                                */
/* ------------------------------------------------------------------ */

const runStatusConfig: Record<
  string,
  { icon: React.ReactNode; className: string; label: string }
> = {
  pending: {
    icon: <Clock className="h-3 w-3" />,
    className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    label: "Pending",
  },
  running: {
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    label: "Running",
  },
  awaiting_review: {
    icon: <CircleDot className="h-3 w-3" />,
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    label: "Awaiting Review",
  },
  completed: {
    icon: <CheckCircle className="h-3 w-3" />,
    className:
      "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    label: "Completed",
  },
  failed: {
    icon: <Clock className="h-3 w-3" />,
    className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    label: "Failed",
  },
};

/* ------------------------------------------------------------------ */
/*  Stage pipeline visualisation                                       */
/* ------------------------------------------------------------------ */

function StagePipeline({
  stages,
  currentStage,
}: {
  stages: WorkflowStage[];
  currentStage?: string | null;
}) {
  const currentIdx = stages.findIndex((s) => s.name === currentStage);

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {stages.map((stage, idx) => {
        const isDone = currentIdx > idx;
        const isCurrent = currentIdx === idx;

        return (
          <div key={stage.name} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
                isCurrent
                  ? "border-primary bg-primary text-primary-foreground"
                  : isDone
                    ? "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300"
                    : "border-border bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : isCurrent ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CircleDot className="h-3.5 w-3.5 opacity-40" />
              )}
              {stage.name}
            </div>

            {idx < stages.length - 1 && (
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </div>
        );
      })}

      {/* "Done" terminus */}
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${
          currentStage === "__done__" || currentIdx === -1
            ? "border-border bg-muted text-muted-foreground"
            : "border-border bg-muted text-muted-foreground"
        }`}
      >
        <CheckCircle className="h-3.5 w-3.5 opacity-40" />
        Done
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                */
/* ------------------------------------------------------------------ */

export default function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Run dialog
  const [runOpen, setRunOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [credSets, setCredSets] = useState<CredentialSet[]>([]);
  const [runForm, setRunForm] = useState({
    projectId: "",
    credentialSetId: "",
    taskDescription: "",
  });

  // Collapsible prompt templates
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  // Editing state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStages, setEditStages] = useState<WorkflowStage[]>([]);

  const toggleStage = (name: string) =>
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const startEditing = () => {
    if (!template) return;
    setEditName(template.name);
    setEditDescription(template.description || "");
    setEditStages(template.stages.map((s) => ({ ...s })));
    setEditing(true);
  };

  const cancelEditing = () => setEditing(false);

  const saveEditing = async () => {
    if (editStages.length === 0) {
      toast.error("Workflow must have at least one stage");
      return;
    }
    if (editStages.some((s) => !s.name.trim())) {
      toast.error("All stages must have a name");
      return;
    }
    const res = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        description: editDescription,
        stages: editStages,
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      setTemplate(updated);
      setEditing(false);
      toast.success("Workflow updated");
    } else {
      toast.error("Failed to save workflow");
    }
  };

  const addStage = () => {
    setEditStages((prev) => [
      ...prev,
      {
        name: `stage-${prev.length + 1}`,
        promptTemplate: "",
        autoAdvance: false,
        reviewRequired: true,
        freshSession: false,
      },
    ]);
  };

  const removeStage = (idx: number) => {
    setEditStages((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveStage = (idx: number, dir: -1 | 1) => {
    setEditStages((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const updateStage = (idx: number, patch: Partial<WorkflowStage>) => {
    setEditStages((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  };

  /* ---- data loading ---- */

  const loadData = useCallback(() => {
    Promise.all([
      fetch(`/api/workflows/${id}`).then(async (r) => {
        if (!r.ok) {
          setNotFound(true);
          return;
        }
        setTemplate(await r.json());
      }),
      // Fetch all workflow data and filter runs client-side
      fetch("/api/workflows")
        .then((r) => r.json())
        .then((data: unknown[]) => {
          const filtered = (data as WorkflowRun[]).filter(
            (item) =>
              "workflowTemplateId" in item && item.workflowTemplateId === id,
          );
          setRuns(filtered);
        })
        .catch(() => setRuns([])),
    ]).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---- open run dialog → load projects & creds ---- */

  const openRunDialog = () => {
    setRunOpen(true);
    Promise.all([
      fetch("/api/projects")
        .then((r) => r.json())
        .then(setProjects),
      fetch("/api/credentials")
        .then((r) => r.json())
        .then(setCredSets),
    ]).catch(() => toast.error("Failed to load projects or credentials"));
  };

  /* ---- start run ---- */

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!runForm.projectId || !runForm.taskDescription.trim()) {
      toast.error("Please select a project and describe the task");
      return;
    }
    setStarting(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_run",
          workflowTemplateId: id,
          projectId: runForm.projectId,
          taskDescription: runForm.taskDescription,
          credentialSetId: runForm.credentialSetId || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to start workflow run");
        return;
      }
      const result = await res.json();
      toast.success("Workflow run started");
      setRunOpen(false);
      setRunForm({ projectId: "", credentialSetId: "", taskDescription: "" });
      // Navigate to the session that was created for the first stage
      if (result.taskId) {
        router.push(`/`);
      } else {
        loadData();
      }
    } catch {
      toast.error("Failed to start workflow run");
    } finally {
      setStarting(false);
    }
  };

  /* ---- delete template ---- */

  const handleDeleteRun = async (runId: string) => {
    if (!window.confirm("Delete this workflow run and all its tasks? This cannot be undone."))
      return;
    try {
      const res = await fetch(`/api/workflows/runs/${runId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete run");
        return;
      }
      toast.success("Workflow run deleted");
      setRuns((prev) => prev.filter((r) => r.id !== runId));
    } catch {
      toast.error("Failed to delete run");
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this workflow template? This cannot be undone."))
      return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete template");
        return;
      }
      toast.success("Template deleted");
      router.push("/workflows");
    } catch {
      toast.error("Failed to delete template");
    } finally {
      setDeleting(false);
    }
  };

  /* ---- loading / not-found states ---- */

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !template) {
    return (
      <div className="space-y-4 py-10 text-center">
        <p className="text-muted-foreground">Workflow template not found.</p>
        <Link href="/workflows">
          <Button variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Workflows
          </Button>
        </Link>
      </div>
    );
  }

  /* ---- main render ---- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Link href="/workflows">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">
              {template.name}
            </h1>
          </div>
          {template.description && (
            <p className="ml-12 text-muted-foreground">
              {template.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={openRunDialog}>
            <Play className="mr-2 h-4 w-4" />
            Run Workflow
          </Button>
          <Button
            variant="destructive"
            size="icon"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Stage pipeline visualisation */}
      <Card>
        <CardHeader>
          <CardTitle>Stage Progression</CardTitle>
        </CardHeader>
        <CardContent>
          <StagePipeline stages={editing ? editStages : template.stages} />
        </CardContent>
      </Card>

      {/* Stage definitions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>
              Stages{" "}
              <Badge variant="secondary" className="ml-2">
                {editing ? editStages.length : template.stages.length}
              </Badge>
            </CardTitle>
            {!editing ? (
              <Button variant="outline" size="sm" onClick={startEditing}>
                <Pencil className="mr-1 h-3 w-3" />
                Edit
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveEditing}>
                  <Save className="mr-1 h-3 w-3" />
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelEditing}>
                  <X className="mr-1 h-3 w-3" />
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {editing ? (
            <>
              {/* Editable name & description */}
              <div className="space-y-3 mb-4">
                <div className="space-y-1">
                  <Label className="text-xs">Workflow Name</Label>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Optional description"
                  />
                </div>
              </div>
              <Separator />
              {/* Editable stages */}
              {editStages.map((stage, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {idx + 1}
                      </span>
                      <Input
                        value={stage.name}
                        onChange={(e) =>
                          updateStage(idx, { name: e.target.value })
                        }
                        className="h-8 w-48 text-sm font-medium"
                        placeholder="Stage name"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={idx === 0}
                        onClick={() => moveStage(idx, -1)}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={idx === editStages.length - 1}
                        onClick={() => moveStage(idx, 1)}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => removeStage(idx)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={stage.promptTemplate}
                    onChange={(e) =>
                      updateStage(idx, { promptTemplate: e.target.value })
                    }
                    placeholder="Prompt template for this stage..."
                    className="text-sm min-h-[80px]"
                  />
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={stage.reviewRequired}
                        onChange={(e) =>
                          updateStage(idx, {
                            reviewRequired: e.target.checked,
                            autoAdvance: !e.target.checked,
                          })
                        }
                      />
                      Review required
                    </label>
                    <label
                      className="flex items-center gap-2 text-sm"
                      title="Start a new agent session instead of continuing. Clears agent context and injects only the plan from the previous stage's review."
                    >
                      <input
                        type="checkbox"
                        checked={stage.freshSession ?? false}
                        onChange={(e) =>
                          updateStage(idx, {
                            freshSession: e.target.checked,
                          })
                        }
                      />
                      Fresh session
                    </label>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={addStage}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Stage
              </Button>
            </>
          ) : (
            /* Read-only stages */
            template.stages.map((stage, idx) => (
              <div
                key={stage.name}
                className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {idx + 1}
                    </span>
                    <span className="font-medium">{stage.name}</span>
                    <div className="flex gap-1.5">
                      {stage.reviewRequired && (
                        <Badge variant="outline">Review Required</Badge>
                      )}
                      {stage.freshSession && (
                        <Badge variant="secondary">Fresh session</Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleStage(stage.name)}
                  >
                    {expandedStages.has(stage.name)
                      ? "Hide prompt"
                      : "Show prompt"}
                  </Button>
                </div>
                {expandedStages.has(stage.name) && (
                  <pre className="mt-3 max-h-60 overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
                    {stage.promptTemplate}
                  </pre>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Recent runs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No runs yet. Click &quot;Run Workflow&quot; to start one.
            </p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const cfg = runStatusConfig[run.status] ??
                  runStatusConfig.pending;
                return (
                  <div
                    key={run.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <Badge className={cfg.className}>
                        {cfg.icon}
                        <span className="ml-1">{cfg.label}</span>
                      </Badge>
                      {run.currentStage && (
                        <span className="text-sm text-muted-foreground">
                          Stage: {run.currentStage}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRun(run.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Metadata */}
      <p className="text-xs text-muted-foreground">
        Created {new Date(template.createdAt).toLocaleString()}
        {template.updatedAt &&
          ` · Updated ${new Date(template.updatedAt).toLocaleString()}`}
      </p>

      {/* Run Workflow dialog */}
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Workflow</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleStartRun} className="space-y-4">
            <div className="space-y-2">
              <Label>Project *</Label>
              <Select
                value={runForm.projectId}
                onValueChange={(v) =>
                  setRunForm((f) => ({ ...f, projectId: v ?? "" }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a project…">
                    {projects.find((p) => p.id === runForm.projectId)?.name}
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

            <div className="space-y-2">
              <Label>Credential Set (optional)</Label>
              <Select
                value={runForm.credentialSetId}
                onValueChange={(v) =>
                  setRunForm((f) => ({ ...f, credentialSetId: v ?? "" }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None">
                    {credSets.find((c) => c.id === runForm.credentialSetId)
                      ?.name ?? "None"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {credSets.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Task Description *</Label>
              <Textarea
                value={runForm.taskDescription}
                onChange={(e) =>
                  setRunForm((f) => ({ ...f, taskDescription: e.target.value }))
                }
                placeholder="Describe the feature or task to implement..."
                className="min-h-[100px]"
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={starting}>
              {starting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start Run
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
