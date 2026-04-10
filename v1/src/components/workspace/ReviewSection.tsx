"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  ChevronDown,
  ChevronRight,
  Check,
  GitFork,
  MessageSquare,
  GitPullRequestArrow,
  History,
} from "lucide-react";
import { toast } from "sonner";
import { ReviewSummary } from "@/components/diff-viewer/ReviewSummary";
import { DiffView, type InlineComment } from "@/components/diff-viewer/DiffView";
import { FileTree } from "@/components/diff-viewer/FileTree";
import { parseUnifiedDiff } from "@/lib/services/diff-service";
import type { DiffFile } from "@/lib/services/diff-service";
import { Markdown } from "@/components/ui/markdown";
import { reviewStatusConfig, isReviewPending } from "@/lib/status-config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Review {
  id: string;
  taskId: string;
  workflowRunId: string | null;
  round: number;
  status: string;
  aiSummary: string | null;
  diffSnapshot: string | null;
  planMarkdown: string | null;
  createdAt: string;
}

interface ReviewComment {
  id: string;
  reviewId: string;
  filePath: string;
  lineNumber: number | null;
  side: string | null;
  body: string;
  createdAt: string;
}

interface TaskInfo {
  id: string;
  originTaskId: string | null;
}

interface ReviewSectionProps {
  taskId: string;
  taskStatus: string;
  onReviewAction?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ReviewSection({
  taskId,
  taskStatus,
  onReviewAction,
}: ReviewSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<{ branches: string[]; current: string }>({ branches: [], current: "" });
  const [selectedTargetBranch, setSelectedTargetBranch] = useState<string>("");

  // ── Fetch all reviews in the task chain ──────────────────────────────────

  const fetchReviews = useCallback(async () => {
    try {
      // Fetch task info to get originTaskId
      const taskRes = await fetch(`/api/tasks/${taskId}`);
      if (!taskRes.ok) return;
      const taskInfo: TaskInfo = await taskRes.json();
      const originId = taskInfo.originTaskId ?? taskId;

      // Fetch all reviews and filter by task chain
      const reviewsRes = await fetch("/api/reviews");
      if (!reviewsRes.ok) return;
      const allReviews: Review[] = await reviewsRes.json();

      // Include reviews whose taskId matches this task, the origin, or any
      // task that shares the same origin.
      const chainReviews = allReviews.filter(
        (r) =>
          r.taskId === taskId ||
          r.taskId === originId ||
          // Fetch individual tasks would be expensive, so we also do a
          // secondary pass: any review whose taskId equals one of the other
          // reviews' taskIds with matching origin.  In practice the API
          // returns reviews that already have a `taskId` which is either
          // the current task or one in its chain.
          allReviews.some(
            (other) =>
              other.taskId === r.taskId &&
              (other.taskId === taskId || other.taskId === originId)
          )
      );

      // To find *all* chain reviews properly, also check other tasks that
      // share the same origin by fetching their task info.  We collect
      // unique taskIds from the review set and check them.
      const uniqueTaskIds = [
        ...new Set(allReviews.map((r) => r.taskId)),
      ].filter((id) => id !== taskId && id !== originId);

      const chainTaskIds = new Set<string>([taskId, originId]);

      // Batch-check tasks for chain membership
      await Promise.all(
        uniqueTaskIds.map(async (tid) => {
          try {
            const res = await fetch(`/api/tasks/${tid}`);
            if (!res.ok) return;
            const t: TaskInfo = await res.json();
            if (
              t.originTaskId === originId ||
              t.id === originId
            ) {
              chainTaskIds.add(tid);
            }
          } catch {
            // ignore
          }
        })
      );

      const filtered = allReviews
        .filter((r) => chainTaskIds.has(r.taskId))
        .sort((a, b) => a.round - b.round);

      setReviews(filtered);

      // Auto-select latest round
      if (filtered.length > 0) {
        const latest = filtered[filtered.length - 1];
        setSelectedRound((prev) => prev ?? String(latest.round));
      }
    } catch {
      // silently fail — component will show nothing
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    setReviews([]);
    setComments([]);
    setSelectedRound(null);
    setSelectedFile(undefined);
    fetchReviews();
  }, [taskId, fetchReviews]);

  // ── Fetch branches for target branch selector ───────────────────────────

  useEffect(() => {
    async function loadBranches() {
      try {
        const taskRes = await fetch(`/api/tasks/${taskId}`);
        if (!taskRes.ok) return;
        const task = await taskRes.json();

        const branchRes = await fetch(`/api/projects/${task.projectId}/branches`);
        if (!branchRes.ok) return;
        const branchData = await branchRes.json();
        setBranches(branchData);
        setSelectedTargetBranch(task.targetBranch || task.branch || branchData.current || "");
      } catch {
        // ignore
      }
    }
    loadBranches();
  }, [taskId]);

  // Auto-expand when task is awaiting review
  useEffect(() => {
    if (taskStatus === "awaiting_review" && reviews.length > 0) {
      setExpanded(true);
    }
  }, [taskStatus, reviews.length]);

  // ── Currently selected review ────────────────────────────────────────────

  const activeReview = useMemo(() => {
    if (!selectedRound) return reviews[reviews.length - 1] ?? null;
    return (
      reviews.find((r) => String(r.round) === selectedRound) ?? null
    );
  }, [reviews, selectedRound]);

  // ── Parse diff files ─────────────────────────────────────────────────────

  const diffFiles = useMemo<DiffFile[]>(() => {
    if (!activeReview?.diffSnapshot) return [];
    return parseUnifiedDiff(activeReview.diffSnapshot);
  }, [activeReview?.diffSnapshot]);

  // ── Load comments for active review ──────────────────────────────────────

  useEffect(() => {
    if (!activeReview) {
      setComments([]);
      return;
    }

    const controller = new AbortController();

    async function fetchComments() {
      try {
        const res = await fetch(
          `/api/reviews/${activeReview!.id}/comments`,
          { signal: controller.signal }
        );
        if (res.ok) {
          setComments(await res.json());
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // ignore other fetch errors
      }
    }

    fetchComments();
    return () => controller.abort();
  }, [activeReview?.id]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleAddComment(comment: InlineComment) {
    if (!activeReview) return;
    const res = await fetch(`/api/reviews/${activeReview.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment),
    });
    if (res.ok) {
      const newComment: ReviewComment = await res.json();
      setComments((prev) => [...prev, newComment]);
      toast.success("Comment added");
    }
  }

  async function handleSubmit(action: "approve" | "request_changes") {
    if (!activeReview) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/reviews/${activeReview.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "approve" && selectedTargetBranch ? { targetBranch: selectedTargetBranch } : {}),
        }),
      });
      if (res.ok) {
        const result = await res.json();
        // Update review status locally
        setReviews((prev) =>
          prev.map((r) =>
            r.id === activeReview.id ? { ...r, status: result.status } : r
          )
        );

        if (action === "approve") {
          if (result.merged) {
            const strategyText = result.mergeStrategy === "fast-forward"
              ? " (fast-forward)"
              : result.mergeStrategy === "no-ff"
                ? " (merge commit — rebase had conflicts)"
                : "";
            toast.success(`Changes approved and merged${strategyText}!`);
          } else if (result.mergeError) {
            toast.success(
              "Changes approved! Merge failed — merge the branch manually.",
              { duration: 6000 }
            );
          } else {
            toast.success("Changes approved!");
          }
          if (result.workflowAdvanced?.nextStage) {
            toast.info(
              `Workflow advancing to stage: ${result.workflowAdvanced.nextStage}`
            );
          } else if (result.workflowAdvanced?.completed) {
            toast.success("Workflow completed!");
          }
        } else {
          toast.success("Changes requested — new agent run will be spawned");
        }

        onReviewAction?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(`Submit failed: ${err?.error ?? "Unknown error"}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render nothing when there's no review data ───────────────────────────

  if (loading) return null;
  if (reviews.length === 0) {
    if (taskStatus === "awaiting_review") {
      return (
        <div className="shrink-0 border-t px-4 py-3 text-sm text-muted-foreground">
          No review yet
        </div>
      );
    }
    return null;
  }

  const latestReview = reviews[reviews.length - 1];
  const isPending = isReviewPending(activeReview?.status ?? "");

  // ── Collapsed bar ────────────────────────────────────────────────────────

  if (!expanded) {
    return (
      <button
        className="shrink-0 flex w-full items-center gap-3 border-t px-4 py-3 text-left text-sm hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(true)}
      >
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        <GitPullRequestArrow className="h-4 w-4 shrink-0" />
        <span className="font-medium">Review Changes</span>
        <span className="text-muted-foreground">
          Round {latestReview.round}
        </span>
        <span className="text-muted-foreground">·</span>
        <Badge className={reviewStatusConfig[latestReview.status]?.colorClass ?? ""}>
          {reviewStatusConfig[latestReview.status]?.label ?? latestReview.status}
        </Badge>
      </button>
    );
  }

  // ── Expanded view ────────────────────────────────────────────────────────

  return (
    <div className="shrink-0 flex flex-col border-t">
      {/* Header bar */}
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(false)}
      >
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        <GitPullRequestArrow className="h-4 w-4 shrink-0" />
        <span className="font-medium">Review Changes</span>

        {/* Round selector (inline tabs when multiple rounds) */}
        {reviews.length > 1 && (
          <div
            className="ml-2 flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <History className="h-3 w-3 text-muted-foreground" />
            <Tabs
              value={selectedRound ?? String(latestReview.round)}
              onValueChange={setSelectedRound}
            >
              <TabsList className="h-7">
                {reviews.map((r) => (
                  <TabsTrigger
                    key={r.round}
                    value={String(r.round)}
                    className="h-5 px-2 text-xs"
                  >
                    {r.round}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        )}

        <div className="ml-auto">
          {activeReview && (
            <Badge className={reviewStatusConfig[activeReview.status]?.colorClass ?? ""}>
              {reviewStatusConfig[activeReview.status]?.label ?? activeReview.status}
            </Badge>
          )}
        </div>
      </button>

      {/* Body */}
      <ScrollArea className="max-h-[70vh]">
        <div className="space-y-4 px-4 pb-4">
          {/* AI Summary */}
          {activeReview?.aiSummary && (
            <ReviewSummary
              summary={activeReview.aiSummary}
              round={activeReview.round}
              status={activeReview.status}
            />
          )}

          {/* Agent Plan */}
          {activeReview?.planMarkdown && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Agent Plan</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown>{activeReview.planMarkdown}</Markdown>
              </CardContent>
            </Card>
          )}

          {/* Action buttons */}
          {isPending && (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                {branches.branches.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Merge into:</span>
                    <Select
                      value={selectedTargetBranch}
                      onValueChange={(v) => setSelectedTargetBranch(v ?? "")}
                    >
                      <SelectTrigger className="h-8 w-[160px] text-xs">
                        <SelectValue placeholder="Select branch...">
                          {selectedTargetBranch || "Select branch..."}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {branches.branches.map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  onClick={() => handleSubmit("approve")}
                  className="bg-green-600 hover:bg-green-700"
                  disabled={submitting}
                >
                  <Check className="mr-2 h-4 w-4" />
                  Approve Changes
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleSubmit("request_changes")}
                  disabled={comments.length === 0 || submitting}
                >
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Request Changes ({comments.length} comments)
                </Button>
                {comments.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Add inline comments on the diff below before requesting
                    changes
                  </span>
                )}
              </div>
              <Separator />
            </>
          )}

          {/* Diff viewer */}
          {diffFiles.length > 0 && (
            <div className="grid grid-cols-[200px_1fr] gap-4">
              <FileTree
                files={diffFiles}
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
              />
              <DiffView
                files={
                  selectedFile
                    ? diffFiles.filter((f) => f.path === selectedFile)
                    : diffFiles
                }
                comments={comments}
                onAddComment={isPending ? handleAddComment : undefined}
                readOnly={!isPending}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
