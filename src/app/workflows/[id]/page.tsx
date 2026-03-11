"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  CircleDot,
  Clock,
  Loader2,
  Play,
  Trash2,
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
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
  });

  // Collapsible prompt templates
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());

  const toggleStage = (name: string) =>
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

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
    if (!runForm.projectId) {
      toast.error("Please select a project");
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
      setRunForm({ projectId: "", credentialSetId: "" });
      // Navigate to the session that was created for the first stage
      if (result.sessionId) {
        router.push(`/sessions/${result.sessionId}`);
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
          <StagePipeline stages={template.stages} />
        </CardContent>
      </Card>

      {/* Stage definitions */}
      <Card>
        <CardHeader>
          <CardTitle>
            Stages{" "}
            <Badge variant="secondary" className="ml-2">
              {template.stages.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {template.stages.map((stage, idx) => (
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
                    {stage.autoAdvance && (
                      <Badge variant="secondary">Auto-advance</Badge>
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
          ))}
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
                    <span className="text-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
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
