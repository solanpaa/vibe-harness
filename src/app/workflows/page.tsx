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
import { Plus, Workflow, ArrowRight } from "lucide-react";

interface WorkflowStage {
  name: string;
  promptTemplate: string;
  autoAdvance: boolean;
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
      .then(setTemplates);
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
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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
              Default stages: Plan → Implement → Review (with review gates at each step)
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
                Create a workflow template to define plan → implement → review cycles.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {templates.map((template) => (
            <Card key={template.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{template.name}</CardTitle>
                  <Badge variant="outline">
                    {template.stages.length} stages
                  </Badge>
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
                    <div key={stage.name} className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="capitalize"
                      >
                        {stage.name}
                        {stage.reviewRequired && " 🔍"}
                      </Badge>
                      {i < template.stages.length - 1 && (
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  ))}
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <Badge variant="outline" className="bg-green-50 dark:bg-green-950">
                    Done ✓
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
