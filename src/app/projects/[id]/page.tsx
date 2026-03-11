"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  FolderOpen,
  Play,
  GitBranch,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@/types/domain";

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then(async (r) => {
        if (!r.ok) {
          setNotFound(true);
          return;
        }
        setProject(await r.json());
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleDeleteProject() {
    if (!window.confirm(`Delete project "${project?.name}"?`)) return;

    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Project deleted");
      router.push("/projects");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete project");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (notFound || !project) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/projects")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Projects
        </Button>
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <p className="text-muted-foreground">Project not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/projects")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDeleteProject}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Project
          </Button>
          <Button onClick={() => router.push(`/tasks?projectId=${id}`)}>
            <Play className="mr-2 h-4 w-4" />
            Launch Task
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        <Badge variant="secondary" className="font-mono">
          <FolderOpen className="mr-1 h-3 w-3" />
          {project.localPath}
        </Badge>
        {project.gitUrl && (
          <Badge variant="outline" className="font-mono">
            <GitBranch className="mr-1 h-3 w-3" />
            {project.gitUrl}
          </Badge>
        )}
      </div>
    </div>
  );
}
