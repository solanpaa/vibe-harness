"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  GitFork,
  Pencil,
  Trash2,
  Play,
  X,
  Save,
  FileText,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Proposal {
  id: string;
  taskId: string;
  title: string;
  description: string;
  affectedFiles: string[];
  dependsOn: string[];
  status: string;
  sortOrder: number;
}

interface ProposalReviewPanelProps {
  taskId: string;
  onLaunched?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ProposalReviewPanel({
  taskId,
  onLaunched,
}: ProposalReviewPanelProps) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [useFullWorkflow, setUseFullWorkflow] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Proposal>>({});

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch(`/api/proposals?taskId=${taskId}`);
      if (res.ok) {
        setProposals(await res.json());
      }
    } catch (e) {
      console.error("Failed to fetch proposals:", e);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const handleDelete = async (proposalId: string) => {
    const res = await fetch(`/api/proposals/${proposalId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setProposals((prev) => prev.filter((p) => p.id !== proposalId));
      toast.success("Proposal removed");
    } else {
      toast.error("Failed to delete proposal");
    }
  };

  const handleStartEdit = (proposal: Proposal) => {
    setEditingId(proposal.id);
    setEditForm({
      title: proposal.title,
      description: proposal.description,
      affectedFiles: proposal.affectedFiles,
    });
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const res = await fetch(`/api/proposals/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });
    if (res.ok) {
      setEditingId(null);
      fetchProposals();
      toast.success("Proposal updated");
    } else {
      toast.error("Failed to update proposal");
    }
  };

  const handleLaunchAll = async () => {
    setLaunching(true);
    try {
      const activeProposals = proposals.filter(
        (p) => p.status !== "discarded"
      );
      const res = await fetch("/api/proposals/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          proposalIds: activeProposals.map((p) => p.id),
          useFullWorkflow,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        toast.success(
          `Launched ${result.launched} workflow run(s)${result.queued > 0 ? `, ${result.queued} queued` : ""}`
        );
        fetchProposals();
        onLaunched?.();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to launch proposals");
      }
    } catch (e) {
      toast.error("Failed to launch proposals");
    } finally {
      setLaunching(false);
    }
  };

  const handleDiscard = async (proposalId: string) => {
    const res = await fetch(`/api/proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "discarded" }),
    });
    if (res.ok) {
      fetchProposals();
      toast.success("Proposal discarded");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading proposals…
      </div>
    );
  }

  const activeProposals = proposals.filter((p) => p.status !== "discarded");
  const discardedProposals = proposals.filter(
    (p) => p.status === "discarded"
  );
  const hasLaunched = proposals.some((p) => p.status === "launched");

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitFork className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-semibold">
            Split Proposals ({activeProposals.length})
          </h2>
        </div>
        {!hasLaunched && activeProposals.length > 0 && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={useFullWorkflow}
                onChange={(e) => setUseFullWorkflow(e.target.checked)}
                className="rounded"
              />
              Full workflow (plan→implement→review)
            </label>
            <Button onClick={handleLaunchAll} disabled={launching}>
            {launching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Launch All ({activeProposals.length})
          </Button>
          </div>
        )}
        {hasLaunched && (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200">
            Launched
          </Badge>
        )}
      </div>

      {activeProposals.length === 0 && !hasLaunched && (
        <p className="text-sm text-muted-foreground">
          No proposals yet. The split agent should create proposals using
          MCP tools.
        </p>
      )}

      {/* Proposal cards */}
      {activeProposals.map((proposal, idx) => (
        <Card
          key={proposal.id}
          className={`${
            proposal.status === "launched"
              ? "border-green-200 dark:border-green-800"
              : ""
          }`}
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              {editingId === proposal.id ? (
                <Input
                  value={editForm.title || ""}
                  onChange={(e) =>
                    setEditForm({ ...editForm, title: e.target.value })
                  }
                  className="text-sm font-semibold"
                />
              ) : (
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {idx + 1}
                  </span>
                  {proposal.title}
                  {proposal.status === "launched" && (
                    <Badge
                      variant="outline"
                      className="border-green-300 text-green-700"
                    >
                      Launched
                    </Badge>
                  )}
                </CardTitle>
              )}

              {!hasLaunched && (
                <div className="flex shrink-0 gap-1">
                  {editingId === proposal.id ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={handleSaveEdit}
                      >
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditingId(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleStartEdit(proposal)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => handleDiscard(proposal.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {editingId === proposal.id ? (
              <Textarea
                value={editForm.description || ""}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    description: e.target.value,
                  })
                }
                className="mt-2 min-h-[80px] text-sm"
              />
            ) : (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {proposal.description}
              </p>
            )}

            {/* Affected files */}
            {proposal.affectedFiles.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {proposal.affectedFiles.map((f) => (
                  <Badge
                    key={f}
                    variant="secondary"
                    className="text-xs font-mono"
                  >
                    <FileText className="mr-1 h-3 w-3" />
                    {f}
                  </Badge>
                ))}
              </div>
            )}

            {/* Dependencies */}
            {proposal.dependsOn.length > 0 && (
              <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3" />
                Depends on: {proposal.dependsOn.join(", ")}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {/* Discarded proposals (collapsed) */}
      {discardedProposals.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            {discardedProposals.length} discarded proposal(s)
          </summary>
          <div className="mt-2 space-y-2 pl-4">
            {discardedProposals.map((p) => (
              <div key={p.id} className="flex items-center gap-2 opacity-60">
                <span className="line-through">{p.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={async () => {
                    await fetch(`/api/proposals/${p.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: "proposed" }),
                    });
                    fetchProposals();
                    toast.success("Proposal restored");
                  }}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
