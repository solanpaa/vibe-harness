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
  Plus,
  Workflow,
  ArrowRight,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

interface WorkflowStage {
  name: string;
  promptTemplate: string;
  reviewRequired: boolean;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  stages: WorkflowStage[];
  createdAt: string;
}

export default function WorkflowsPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });

  useEffect(() => {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then(setTemplates)
      .catch(() => toast.error("Failed to load workflows"));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_template",
        name: form.name,
        description: form.description,
      }),
    });
    if (res.ok) {
      const template = await res.json();
      setTemplates((prev) => [...prev, template]);
      setForm({ name: "", description: "" });
      setCreateOpen(false);
      toast.success("Workflow created");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to create workflow");
    }
  }

  async function handleDelete(e: React.MouseEvent, template: WorkflowTemplate) {
    e.stopPropagation();
    e.preventDefault();

    if (!window.confirm(`Delete workflow "${template.name}"?`)) return;

    const res = await fetch(`/api/workflows/${template.id}`, {
      method: "DELETE",
    });

    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      toast.success("Workflow deleted");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete workflow");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Workflows</h1>
          <p className="text-muted-foreground">
            Define and run multi-stage agent workflows with review gates
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Workflow
        </Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workflow Template</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Standard dev workflow"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Plan → Implement → Review cycle"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Default stages: Plan → Implement → Review (with review gates at
              each step)
            </p>
            <Button type="submit" className="w-full">
              Create Workflow
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <Workflow className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No workflows yet.</p>
              <p className="text-sm">
                Create a workflow template to define plan → implement → review
                cycles.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {templates.map((template) => (
            <Link key={template.id} href={`/workflows/${template.id}`}>
              <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Workflow className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-lg">
                        {template.name}
                      </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {template.stages.length} stages
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={(e) => handleDelete(e, template)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  {template.description && (
                    <p className="text-sm text-muted-foreground">
                      {template.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 flex-wrap">
                    {template.stages.map((stage, i) => (
                      <div
                        key={stage.name}
                        className="flex items-center gap-2"
                      >
                        <Badge variant="secondary" className="capitalize">
                          {stage.name}
                          {stage.reviewRequired && " 🔍"}
                        </Badge>
                        {i < template.stages.length - 1 && (
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                    ))}
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <Badge
                      variant="outline"
                      className="bg-green-50 dark:bg-green-950"
                    >
                      Done ✓
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
