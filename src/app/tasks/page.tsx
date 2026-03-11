"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Terminal,
  Play,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Trash2,
  GitPullRequestArrow,
  Workflow,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

interface Task {
  id: string;
  projectId: string;
  agentDefinitionId: string;
  credentialSetId: string | null;
  status: string;
  prompt: string;
  createdAt: string;
  completedAt: string | null;
}

interface Project {
  id: string;
  name: string;
  localPath: string;
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

const statusConfig: Record<string, { icon: React.ReactNode; color: string }> = {
  pending: {
    icon: <Clock className="h-4 w-4" />,
    color: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  },
  running: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  awaiting_review: {
    icon: <GitPullRequestArrow className="h-4 w-4" />,
    color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  },
  completed: {
    icon: <CheckCircle className="h-4 w-4" />,
    color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  failed: {
    icon: <XCircle className="h-4 w-4" />,
    color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
};

function relativeTime(iso: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(iso).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksContent />
    </Suspense>
  );
}

interface WorkflowTemplate {
  id: string;
  name: string;
  stages: Array<{ name: string; promptTemplate: string; reviewRequired: boolean }>;
}

function TasksContent() {
  const searchParams = useSearchParams();
  const urlProjectId = searchParams.get("projectId") ?? "";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [credSets, setCredSets] = useState<CredentialSet[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    projectId: "",
    agentDefinitionId: "",
    credentialSetId: "",
    model: "",
    useWorktree: true,
    workflowTemplateId: "",
    prompt: "",
  });

  const loadTasks = useCallback(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTasks();
    fetch("/api/projects").then((r) => r.json()).then(setProjects).catch(() => {});
    fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
    fetch("/api/credentials").then((r) => r.json()).then(setCredSets).catch(() => {});
    fetch("/api/workflows").then((r) => r.json()).then(setWorkflows).catch(() => {});
  }, [loadTasks]);

  // Poll tasks every 5 seconds
  useEffect(() => {
    const id = setInterval(loadTasks, 5000);
    return () => clearInterval(id);
  }, [loadTasks]);

  // Auto-select first agent when agents load
  useEffect(() => {
    if (agents.length > 0 && !form.agentDefinitionId) {
      setForm((f) => ({ ...f, agentDefinitionId: agents[0].id }));
    }
  }, [agents, form.agentDefinitionId]);

  // Auto-select project from URL ?projectId
  useEffect(() => {
    if (urlProjectId && projects.length > 0) {
      const match = projects.find((p) => p.id === urlProjectId);
      if (match) {
        setForm((f) => ({ ...f, projectId: match.id }));
      }
    }
  }, [urlProjectId, projects]);

  const selectedWorkflow = workflows.find((w) => w.id === form.workflowTemplateId);
  const isWorkflowMode = !!form.workflowTemplateId;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.projectId || !form.agentDefinitionId || !form.prompt.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    setLoading(true);
    try {
      if (isWorkflowMode) {
        // Workflow mode: create workflow run which starts the first stage
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
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          toast.error(body?.error ?? "Failed to start workflow");
          return;
        }
        const result = await res.json();
        toast.success(`Workflow started — stage: ${result.stageName}`);
        setCreateOpen(false);
        loadTasks();
      } else {
        // One-off task mode
        const createRes = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: form.projectId,
            agentDefinitionId: form.agentDefinitionId,
            credentialSetId: form.credentialSetId || null,
            model: form.model.trim() || null,
            useWorktree: form.useWorktree,
            prompt: form.prompt,
          }),
        });
        if (!createRes.ok) {
          const body = await createRes.json().catch(() => null);
          toast.error(body?.error ?? "Failed to create task");
          return;
        }
        const task = await createRes.json();

        const startRes = await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        });
        if (!startRes.ok) {
          const body = await startRes.json().catch(() => null);
          toast.error(
            `Task created but failed to start: ${body?.error ?? "unknown error"}`
          );
        } else {
          toast.success("Task created and started");
        }
        setCreateOpen(false);
        loadTasks();
      }

      setForm({
        projectId: urlProjectId || "",
        agentDefinitionId: agents[0]?.id ?? "",
        credentialSetId: "",
        model: "",
        useWorktree: true,
        workflowTemplateId: "",
        prompt: "",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(taskId: string) {
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to delete task");
        return;
      }
      toast.success("Task deleted");
      loadTasks();
    } catch {
      toast.error("Failed to delete task");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
          <p className="text-muted-foreground">
            Agent coding tasks running in Docker sandboxes
          </p>
        </div>
        <div className="flex items-center gap-2">
          {projects.length === 0 && (
            <span className="text-sm text-muted-foreground">
              Create a project first
            </span>
          )}
          <Button
            onClick={() => setCreateOpen(true)}
            disabled={projects.length === 0}
          >
            <Plus className="mr-2 h-4 w-4" />
            New Task
          </Button>
        </div>
      </div>

      {/* Create Task Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Launch Agent Task</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Project *</Label>
              <Select
                value={form.projectId}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, projectId: v ?? "" }))
                }
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

            <div className="space-y-2">
              <Label>Agent *</Label>
              <Select
                value={form.agentDefinitionId}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, agentDefinitionId: v ?? "" }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent...">
                    {(() => { const a = agents.find((a) => a.id === form.agentDefinitionId); return a ? `${a.name} (${a.type})` : undefined; })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Model (optional)</Label>
              <input
                type="text"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.model}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                placeholder="claude-opus-4.6"
              />
            </div>

            <div className="space-y-2">
              <Label>Credential Set (optional)</Label>
              <Select
                value={form.credentialSetId}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, credentialSetId: v === "none" ? "" : (v ?? "") }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None">
                    {credSets.find((c) => c.id === form.credentialSetId)?.name ?? (form.credentialSetId ? undefined : "None")}
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

            <div className="space-y-2">
              <Label>Workflow (optional)</Label>
              <Select
                value={form.workflowTemplateId}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, workflowTemplateId: v === "none" ? "" : (v ?? "") }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None — one-off task">
                    {selectedWorkflow?.name ?? "None — one-off task"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None — one-off task</SelectItem>
                  {workflows.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      <div className="flex items-center gap-2">
                        <Workflow className="h-3 w-3" />
                        {w.name} ({w.stages.length} stages)
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedWorkflow && (
                <div className="flex items-center gap-1 flex-wrap text-xs text-muted-foreground mt-1">
                  {selectedWorkflow.stages.map((stage, i) => (
                    <span key={stage.name} className="flex items-center gap-1">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {stage.name}
                      </Badge>
                      {i < selectedWorkflow.stages.length - 1 && (
                        <ArrowRight className="h-3 w-3" />
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="useWorktree"
                checked={form.useWorktree}
                onChange={(e) =>
                  setForm((f) => ({ ...f, useWorktree: e.target.checked }))
                }
              />
              <Label htmlFor="useWorktree">
                Use Git Worktree (isolated copy of the repo)
              </Label>
            </div>

            <div className="space-y-2">
              <Label>{isWorkflowMode ? "Task Description *" : "Prompt *"}</Label>
              <Textarea
                value={form.prompt}
                onChange={(e) =>
                  setForm((f) => ({ ...f, prompt: e.target.value }))
                }
                placeholder={isWorkflowMode
                  ? "Describe the feature or task to implement..."
                  : "Describe what you want the agent to do..."}
                className="min-h-[120px]"
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Launching...
                </>
              ) : isWorkflowMode ? (
                <>
                  <Workflow className="mr-2 h-4 w-4" />
                  Launch Workflow
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Launch Task
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Tasks list */}
      {tasks.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <Terminal className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No tasks yet.</p>
              <p className="text-sm">
                {projects.length === 0
                  ? "Create a project first, then launch a task."
                  : 'Click "New Task" to launch an agent.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {[...tasks]
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
            )
            .map((task) => {
              const project = projects.find(
                (p) => p.id === task.projectId
              );
              const agent = agents.find(
                (a) => a.id === task.agentDefinitionId
              );
              const config =
                statusConfig[task.status] || statusConfig.pending;

              return (
                <Link key={task.id} href={`/tasks/${task.id}`}>
                  <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
                    <CardHeader className="py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          {config.icon}
                          <div className="min-w-0">
                            <CardTitle className="text-base">
                              {project?.name || "Unknown project"}
                            </CardTitle>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-md">
                              {task.prompt}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {agent && (
                            <Badge variant="outline" className="text-xs">
                              {agent.name}
                            </Badge>
                          )}
                          <Badge className={config.color}>
                            {task.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {relativeTime(task.createdAt)}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              handleDelete(task.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              );
            })}
        </div>
      )}
    </div>
  );
}
