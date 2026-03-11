"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  Square,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

interface Session {
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
  completed: {
    icon: <CheckCircle className="h-4 w-4" />,
    color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  failed: {
    icon: <XCircle className="h-4 w-4" />,
    color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
  paused: {
    icon: <Square className="h-4 w-4" />,
    color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  },
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [credSets, setCredSets] = useState<CredentialSet[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    projectId: "",
    agentDefinitionId: "",
    credentialSetId: "",
    prompt: "",
  });

  function loadSessions() {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then(setSessions);
  }

  useEffect(() => {
    loadSessions();
    fetch("/api/projects").then((r) => r.json()).then(setProjects);
    fetch("/api/agents").then((r) => r.json()).then(setAgents);
    fetch("/api/credentials").then((r) => r.json()).then(setCredSets);
  }, []);

  // Auto-select first agent when agents load
  useEffect(() => {
    if (agents.length > 0 && !form.agentDefinitionId) {
      setForm((f) => ({ ...f, agentDefinitionId: agents[0].id }));
    }
  }, [agents, form.agentDefinitionId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.projectId || !form.agentDefinitionId || !form.prompt.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    setLoading(true);
    try {
      // Create the session
      const createRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: form.projectId,
          agentDefinitionId: form.agentDefinitionId,
          credentialSetId: form.credentialSetId || null,
          prompt: form.prompt,
        }),
      });
      if (!createRes.ok) {
        toast.error("Failed to create session");
        return;
      }
      const session = await createRes.json();

      // Start the session
      const startRes = await fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (!startRes.ok) {
        const err = await startRes.json();
        toast.error(`Session created but failed to start: ${err.error}`);
      } else {
        toast.success("Session created and started");
      }

      setForm({ projectId: "", agentDefinitionId: agents[0]?.id || "", credentialSetId: "", prompt: "" });
      setCreateOpen(false);
      loadSessions();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
          <p className="text-muted-foreground">
            Agent coding sessions running in Docker sandboxes
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={projects.length === 0}>
          <Plus className="mr-2 h-4 w-4" />
          New Session
        </Button>
      </div>

      {/* Create Session Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Launch Agent Session</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Project *</Label>
              <Select
                value={form.projectId}
                onValueChange={(v) => setForm((f) => ({ ...f, projectId: v ?? "" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a project..." />
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
              <Label>Agent</Label>
              <Select
                value={form.agentDefinitionId}
                onValueChange={(v) => setForm((f) => ({ ...f, agentDefinitionId: v ?? "" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent..." />
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
              <Label>Credential Set (optional)</Label>
              <Select
                value={form.credentialSetId}
                onValueChange={(v) => setForm((f) => ({ ...f, credentialSetId: v ?? "" }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
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
              <Label>Prompt *</Label>
              <Textarea
                value={form.prompt}
                onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                placeholder="Describe what you want the agent to do..."
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
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Launch Session
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sessions list */}
      {sessions.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <Terminal className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No sessions yet.</p>
              <p className="text-sm">
                {projects.length === 0
                  ? "Create a project first, then launch a session."
                  : "Click \"New Session\" to launch an agent."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )
            .map((session) => {
              const project = projects.find((p) => p.id === session.projectId);
              const agent = agents.find(
                (a) => a.id === session.agentDefinitionId
              );
              const config = statusConfig[session.status] || statusConfig.pending;

              return (
                <Link key={session.id} href={`/sessions/${session.id}`}>
                  <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
                    <CardHeader className="py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {config.icon}
                          <div>
                            <CardTitle className="text-base">
                              {project?.name || "Unknown project"}
                            </CardTitle>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-md">
                              {session.prompt}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {agent && (
                            <Badge variant="outline" className="text-xs">
                              {agent.name}
                            </Badge>
                          )}
                          <Badge className={config.color}>
                            {session.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(session.createdAt).toLocaleString()}
                          </span>
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
