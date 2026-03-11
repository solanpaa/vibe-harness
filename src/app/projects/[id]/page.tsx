"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  ArrowLeft,
  FolderOpen,
  Play,
  GitBranch,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { Project, Subproject } from "@/types/domain";

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
  const [subprojects, setSubprojects] = useState<Subproject[]>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [subForm, setSubForm] = useState({
    name: "",
    description: "",
    pathFilter: "",
  });

  useEffect(() => {
    Promise.all([
      fetch(`/api/projects/${id}`).then(async (r) => {
        if (!r.ok) {
          setNotFound(true);
          return;
        }
        setProject(await r.json());
      }),
      fetch(`/api/subprojects?projectId=${id}`)
        .then((r) => r.json())
        .then(setSubprojects),
    ]).finally(() => setLoading(false));
  }, [id]);

  async function handleDeleteProject() {
    if (!window.confirm(`Delete project "${project?.name}"? This will also delete all its subprojects.`))
      return;

    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Project deleted");
      router.push("/projects");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete project");
    }
  }

  async function handleDeleteSubproject(sub: Subproject) {
    if (!window.confirm(`Delete subproject "${sub.name}"?`)) return;

    const res = await fetch(`/api/subprojects/${sub.id}`, { method: "DELETE" });
    if (res.ok) {
      setSubprojects((prev) => prev.filter((s) => s.id !== sub.id));
      toast.success("Subproject deleted");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete subproject");
    }
  }

  async function handleCreateSubproject(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/subprojects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...subForm, projectId: id }),
    });
    if (res.ok) {
      const sub = await res.json();
      setSubprojects((prev) => [...prev, sub]);
      setSubForm({ name: "", description: "", pathFilter: "" });
      setSubOpen(false);
      toast.success("Subproject created");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to create subproject");
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
          <Button onClick={() => router.push(`/sessions?projectId=${id}`)}>
            <Play className="mr-2 h-4 w-4" />
            Launch Session
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

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Subprojects</h2>
        <Dialog open={subOpen} onOpenChange={setSubOpen}>
          <DialogTrigger
            render={
              <Button variant="outline" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Add Subproject
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Subproject</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateSubproject} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="subName">Name</Label>
                <Input
                  id="subName"
                  value={subForm.name}
                  onChange={(e) =>
                    setSubForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="frontend"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pathFilter">Path Filter (optional)</Label>
                <Input
                  id="pathFilter"
                  value={subForm.pathFilter}
                  onChange={(e) =>
                    setSubForm((f) => ({ ...f, pathFilter: e.target.value }))
                  }
                  placeholder="src/frontend/"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subDesc">Description (optional)</Label>
                <Textarea
                  id="subDesc"
                  value={subForm.description}
                  onChange={(e) =>
                    setSubForm((f) => ({ ...f, description: e.target.value }))
                  }
                />
              </div>
              <Button type="submit" className="w-full">
                Create Subproject
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {subprojects.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-24">
            <p className="text-sm text-muted-foreground">
              No subprojects. Add one to organize work within this project.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {subprojects.map((sub) => (
            <Card key={sub.id}>
              <CardHeader className="py-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{sub.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    {sub.pathFilter && (
                      <Badge variant="outline" className="font-mono text-xs">
                        {sub.pathFilter}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteSubproject(sub)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {sub.description && (
                  <p className="text-sm text-muted-foreground">
                    {sub.description}
                  </p>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
