"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeft,
  Play,
  Square,
  Loader2,
  Clock,
  CheckCircle,
  XCircle,
  Terminal,
  GitPullRequestArrow,
  Trash2,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import AnsiToHtml from "ansi-to-html";

interface Session {
  id: string;
  projectId: string;
  agentDefinitionId: string;
  credentialSetId: string | null;
  sandboxId: string | null;
  status: string;
  prompt: string;
  output: string | null;
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

const statusConfig: Record<
  string,
  { icon: React.ReactNode; color: string; label: string }
> = {
  pending: {
    icon: <Clock className="h-4 w-4" />,
    color: "bg-gray-100 text-gray-800",
    label: "Pending",
  },
  running: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    color: "bg-blue-100 text-blue-800",
    label: "Running",
  },
  completed: {
    icon: <CheckCircle className="h-4 w-4" />,
    color: "bg-green-100 text-green-800",
    label: "Completed",
  },
  failed: {
    icon: <XCircle className="h-4 w-4" />,
    color: "bg-red-100 text-red-800",
    label: "Failed",
  },
};

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [streamOutput, setStreamOutput] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchSession = useCallback(() => {
    return fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((s: Session) => {
        setSession(s);
        return s;
      });
  }, [id]);

  // Load session and related data
  useEffect(() => {
    fetchSession().then((s) => {
      fetch(`/api/projects/${s.projectId}`)
        .then((r) => r.json())
        .then((p: Project) => setProject(p))
        .catch(() => {});

      fetch("/api/agents")
        .then((r) => r.json())
        .then((agents: Agent[]) => {
          setAgent(agents.find((a) => a.id === s.agentDefinitionId) || null);
        });

      if (s.output) {
        setStreamOutput(s.output.split("\n"));
      }
    });
  }, [id, fetchSession]);

  // Connect to SSE stream when session is running
  useEffect(() => {
    if (!session || session.status !== "running") return;

    setIsStreaming(true);
    const es = new EventSource(`/api/sessions/${id}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "output") {
          setStreamOutput((prev) => [...prev, data.data]);
        } else if (data.type === "close") {
          setIsStreaming(false);
          es.close();
          fetchSession();
        } else if (data.type === "error") {
          toast.error(data.message);
          setIsStreaming(false);
          es.close();
          fetchSession();
        }
      } catch {
        setStreamOutput((prev) => [...prev, event.data]);
      }
    };

    es.onerror = () => {
      setIsStreaming(false);
      es.close();
      fetchSession();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [session?.status, id, fetchSession]);

  // Poll session status every 3s when not streaming
  useEffect(() => {
    if (!session || isStreaming) return;
    if (session.status === "completed" || session.status === "failed") return;

    const interval = setInterval(() => {
      fetchSession();
    }, 3000);

    return () => clearInterval(interval);
  }, [session?.status, isStreaming, fetchSession]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamOutput]);

  async function handleStart() {
    const res = await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    if (res.ok) {
      const updated = await res.json();
      setSession(updated);
      toast.success("Session started");
    } else {
      const err = await res.json();
      toast.error(`Failed to start: ${err.error}`);
    }
  }

  async function handleStop() {
    const res = await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    if (res.ok) {
      const updated = await res.json();
      setSession(updated);
      setIsStreaming(false);
      eventSourceRef.current?.close();
      toast.success("Session stopped");
    }
  }

  async function handleCreateReview() {
    const res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    if (res.ok) {
      const review = await res.json();
      toast.success("Review created");
      router.push(`/reviews/${review.id}`);
    } else {
      toast.error("Failed to create review");
    }
  }

  async function handleDelete() {
    if (!window.confirm("Are you sure you want to delete this session?")) return;

    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Session deleted");
      router.push("/sessions");
    } else {
      toast.error("Failed to delete session");
    }
  }

  if (!session) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading session...
      </div>
    );
  }

  const config = statusConfig[session.status] || statusConfig.pending;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/sessions")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      </div>

      {/* Session header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Session — {project?.name || "..."}
          </h1>
          <p className="text-muted-foreground text-sm font-mono mt-1">
            {session.id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {session.status === "pending" && (
            <Button onClick={handleStart}>
              <Play className="mr-2 h-4 w-4" />
              Start
            </Button>
          )}
          {session.status === "running" && (
            <Button variant="destructive" onClick={handleStop}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          )}
          {(session.status === "completed" || session.status === "failed") && (
            <Button onClick={handleCreateReview}>
              <GitPullRequestArrow className="mr-2 h-4 w-4" />
              Create Review
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Metadata */}
      <div className="flex gap-3 flex-wrap items-center">
        <Badge className={config.color}>
          <span className="mr-1">{config.icon}</span>
          {config.label}
        </Badge>
        {agent && (
          <Badge variant="outline">
            {agent.name}
          </Badge>
        )}
        {project?.localPath && (
          <Badge variant="secondary" className="font-mono text-xs">
            {project.localPath}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground flex items-center">
          Created {new Date(session.createdAt).toLocaleString()}
        </span>
        {session.completedAt && (
          <span className="text-xs text-muted-foreground flex items-center">
            • Completed {new Date(session.completedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Prompt */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Prompt</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm whitespace-pre-wrap">{session.prompt}</p>
        </CardContent>
      </Card>

      <Separator />

      {/* Output terminal */}
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <CardTitle className="text-sm">Output</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {session.sandboxId && (session.status === "running" || session.status === "completed" || session.status === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(`docker sandbox run ${session.sandboxId}`);
                    toast.success("Copied! Paste in your terminal to open a shell in the sandbox.");
                  }}
                >
                  <TerminalSquare className="mr-1 h-3 w-3" />
                  Open Shell
                </Button>
              )}
              {isStreaming && (
                <Badge className="bg-blue-100 text-blue-800">
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Live
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px] rounded-lg">
            <div
              ref={outputRef}
              style={{ backgroundColor: "#030712" }}
              className="text-green-400 font-mono text-xs p-4 min-h-[300px] whitespace-pre-wrap"
            >
              {streamOutput.length === 0 ? (
                <span className="text-gray-600">
                  {session.status === "pending"
                    ? "Session not started yet. Click Start to begin."
                    : session.status === "running"
                      ? "Connecting to output stream..."
                      : "No output recorded."}
                </span>
              ) : (
                streamOutput.map((line, i) => {
                  const ansi = new AnsiToHtml({
                    fg: "#4ade80",
                    bg: "#030712",
                    newline: false,
                    escapeXML: true,
                    colors: {
                      0: "#1e1e1e", 1: "#f87171", 2: "#4ade80", 3: "#facc15",
                      4: "#60a5fa", 5: "#c084fc", 6: "#22d3ee", 7: "#e5e7eb",
                      8: "#6b7280", 9: "#fca5a5", 10: "#86efac", 11: "#fde68a",
                      12: "#93c5fd", 13: "#d8b4fe", 14: "#67e8f9", 15: "#f9fafb",
                    },
                  });
                  // Strip OSC sequences (terminal title, etc.)
                  const cleaned = line.replace(/\]0;[^\x07\x1b]*(\x07|\x1b\\)?/g, "");
                  const html = ansi.toHtml(cleaned);
                  return (
                    <div
                      key={i}
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  );
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
