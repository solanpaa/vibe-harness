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

  Loader2,

  Pencil,
  Plus,
  Save,
  Trash2,
  X,

} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type {
  WorkflowStage,
  WorkflowTemplate,
} from "@/types/domain";

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
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
        type: "sequential" as const,
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
    ]).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---- delete template ---- */

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

      {/* Metadata */}
      <p className="text-xs text-muted-foreground">
        Created {new Date(template.createdAt).toLocaleString()}
        {template.updatedAt &&
          ` · Updated ${new Date(template.updatedAt).toLocaleString()}`}
      </p>

    </div>
  );
}
