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
} from "lucide-react";
import type { Project, Subproject } from "@/types/domain";

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [subprojects, setSubprojects] = useState<Subproject[]>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [subForm, setSubForm] = useState({
    name: "",
    description: "",
    pathFilter: "",
  });

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((projects: Project[]) => {
        const p = projects.find((p) => p.id === id);
        if (p) setProject(p);
      });

    fetch(`/api/subprojects?projectId=${id}`)
      .then((r) => r.json())
      .then(setSubprojects);
  }, [id]);

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
    }
  }

  if (!project) {
    return <div className="text-muted-foreground">Loading...</div>;
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
        <Button onClick={() => router.push(`/sessions?projectId=${id}`)}>
          <Play className="mr-2 h-4 w-4" />
          Launch Session
        </Button>
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
                  {sub.pathFilter && (
                    <Badge variant="outline" className="font-mono text-xs">
                      {sub.pathFilter}
                    </Badge>
                  )}
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
