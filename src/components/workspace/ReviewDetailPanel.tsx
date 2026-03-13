"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Check,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  GitFork,
  GitPullRequestArrow,
  History,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { DiffView, type InlineComment } from "@/components/diff-viewer/DiffView";
import { FileTree } from "@/components/diff-viewer/FileTree";
import { parseUnifiedDiff } from "@/lib/services/diff-service";
import type { DiffFile } from "@/lib/services/diff-service";
import {
  GeneralComments,
  GENERAL_COMMENT_FILE_PATH,
  type GeneralComment,
} from "./GeneralComments";
import { Markdown } from "@/components/ui/markdown";
import { isReviewPending } from "@/lib/status-config";
import { reviewStatusConfig } from "@/lib/status-config";

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

// ─── Props ───────────────────────────────────────────────────────────────────

interface ReviewDetailPanelProps {
  reviewId: string;
  taskId: string;
  onNavigateToTask?: (taskId: string) => void;
  onReviewAction?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ReviewDetailPanel({
  reviewId,
  taskId,
  onNavigateToTask,
  onReviewAction,
}: ReviewDetailPanelProps) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedRound, setSelectedRound] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planExpanded, setPlanExpanded] = useState(true);
  const [summaryExpanded, setSummaryExpanded] = useState(true);

  // ── Fetch all reviews in the task chain ──────────────────────────────────

  const fetchReviews = useCallback(async () => {
    try {
      const taskRes = await fetch(`/api/tasks/${taskId}`);
      if (!taskRes.ok) return;
      const taskInfo: TaskInfo = await taskRes.json();
      const originId = taskInfo.originTaskId ?? taskId;

      const reviewsRes = await fetch("/api/reviews");
      if (!reviewsRes.ok) return;
      const allReviews: Review[] = await reviewsRes.json();

      const chainTaskIds = new Set<string>([taskId, originId]);

      const uniqueTaskIds = [
        ...new Set(allReviews.map((r) => r.taskId)),
      ].filter((id) => id !== taskId && id !== originId);

      await Promise.all(
        uniqueTaskIds.map(async (tid) => {
          try {
            const res = await fetch(`/api/tasks/${tid}`);
            if (!res.ok) return;
            const t: TaskInfo = await res.json();
            if (t.originTaskId === originId || t.id === originId) {
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

      // Select the round matching our reviewId, or latest
      const targetReview = filtered.find((r) => r.id === reviewId);
      if (targetReview) {
        setSelectedRound(String(targetReview.round));
      } else if (filtered.length > 0) {
        setSelectedRound(String(filtered[filtered.length - 1].round));
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [taskId, reviewId]);

  useEffect(() => {
    setLoading(true);
    setReviews([]);
    setComments([]);
    setSelectedRound(null);
    setSelectedFile(undefined);
    fetchReviews();
  }, [taskId, reviewId, fetchReviews]);

  // ── Active review ────────────────────────────────────────────────────────

  const activeReview = useMemo(() => {
    if (!selectedRound) return reviews.find((r) => r.id === reviewId) ?? reviews[reviews.length - 1] ?? null;
    return reviews.find((r) => String(r.round) === selectedRound) ?? null;
  }, [reviews, selectedRound, reviewId]);

  // ── Parse diff ───────────────────────────────────────────────────────────

  const diffFiles = useMemo<DiffFile[]>(() => {
    if (!activeReview?.diffSnapshot) return [];
    return parseUnifiedDiff(activeReview.diffSnapshot);
  }, [activeReview?.diffSnapshot]);

  // ── Load comments ────────────────────────────────────────────────────────

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
      }
    }

    fetchComments();
    return () => controller.abort();
  }, [activeReview?.id]);

  // ── Derived data ─────────────────────────────────────────────────────────

  const generalComments: GeneralComment[] = useMemo(
    () =>
      comments
        .filter((c) => c.filePath === GENERAL_COMMENT_FILE_PATH)
        .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })),
    [comments]
  );

  const inlineComments = useMemo(
    () => comments.filter((c) => c.filePath !== GENERAL_COMMENT_FILE_PATH),
    [comments]
  );

  const totalComments = comments.length;
  const isPending = isReviewPending(activeReview?.status ?? "");
  const hasDiff = diffFiles.length > 0;
  const hasPlan = !!activeReview?.planMarkdown;

  // Collapse agent plan by default when there are code changes to review
  useEffect(() => {
    setPlanExpanded(!hasDiff);
  }, [activeReview?.id, hasDiff]);

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

  async function handleAddGeneralComment(body: string) {
    if (!activeReview) return;
    const res = await fetch(`/api/reviews/${activeReview.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: GENERAL_COMMENT_FILE_PATH,
        lineNumber: null,
        side: null,
        body,
      }),
    });
    if (res.ok) {
      const newComment: ReviewComment = await res.json();
      setComments((prev) => [...prev, newComment]);
      toast.success("Comment added");
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!activeReview) return;
    const res = await fetch(
      `/api/reviews/${activeReview.id}/comments/${commentId}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      toast.success("Comment deleted");
    }
  }

  async function handleSubmit(action: "approve" | "request_changes" | "split") {
    if (!activeReview) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/reviews/${activeReview.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const result = await res.json();
        setReviews((prev) =>
          prev.map((r) =>
            r.id === activeReview.id ? { ...r, status: result.status } : r
          )
        );

        if (action === "approve") {
          if (result.merged) {
            toast.success("Changes approved and merged!");
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
        } else if (action === "split") {
          toast.success(
            "Plan approved — split agent launched to decompose into parallel sub-tasks",
            { duration: 5000 }
          );
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

  // ── Loading state ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading review…</p>
      </div>
    );
  }

  if (!activeReview) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">Review not found</p>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* ── Header — elevated surface ─────────────────────────── */}
      <div className="shrink-0 bg-card border-b shadow-sm">
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <GitPullRequestArrow className="h-5 w-5 shrink-0 text-primary" />
                <h2 className="text-lg font-semibold leading-tight">
                  Review — Round {activeReview.round}
                </h2>
                <Badge className={reviewStatusConfig[activeReview.status]?.colorClass ?? ""}>
                  {reviewStatusConfig[activeReview.status]?.label ?? activeReview.status.replace(/_/g, " ")}
                </Badge>
              </div>
              <button
                className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onNavigateToTask?.(taskId)}
              >
                <ArrowLeft className="h-3 w-3" />
                Back to task
              </button>
            </div>

            {/* Round selector */}
            {reviews.length > 1 && (
              <div className="flex items-center gap-2 shrink-0">
                <History className="h-4 w-4 text-muted-foreground" />
                <div className="flex gap-1">
                  {reviews.map((r) => (
                    <button
                      key={r.round}
                      onClick={() => setSelectedRound(String(r.round))}
                      className={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                        String(r.round) === selectedRound
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "bg-muted hover:bg-muted/80 text-muted-foreground"
                      }`}
                    >
                      {r.round}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Action bar — sticky at top */}
        {isPending && (
          <div className="flex items-center gap-3 px-4 pb-3 flex-wrap">
            <Button
              onClick={() => handleSubmit("approve")}
              className="bg-green-600 hover:bg-green-700 shadow-sm"
              disabled={submitting}
            >
              <Check className="mr-2 h-4 w-4" />
              Approve
            </Button>
            {activeReview?.workflowRunId && activeReview?.planMarkdown && (
              <Button
                onClick={() => handleSubmit("split")}
                className="bg-indigo-600 hover:bg-indigo-700 shadow-sm"
                disabled={submitting}
              >
                <GitFork className="mr-2 h-4 w-4" />
                Split &amp; Parallelize
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => handleSubmit("request_changes")}
              disabled={totalComments === 0 || submitting}
            >
              <MessageSquare className="mr-2 h-4 w-4" />
              Request Changes ({totalComments})
            </Button>
            {totalComments === 0 && !activeReview?.planMarkdown && (
              <span className="text-xs text-muted-foreground">
                Add comments before requesting changes
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-5">
          {/* General Comments — elevated card */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <GeneralComments
              comments={generalComments}
              onAddComment={handleAddGeneralComment}
              onDeleteComment={isPending ? handleDeleteComment : undefined}
              readOnly={!isPending}
            />
          </div>

          {/* AI Summary (collapsible) — elevated card */}
          {activeReview.aiSummary && (
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <button
                className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
                onClick={() => setSummaryExpanded((v) => !v)}
              >
                {summaryExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                AI Summary
                <Badge variant="outline" className="ml-auto text-[10px]">Round {activeReview.round}</Badge>
              </button>
              {summaryExpanded && (
                <div className="border-t px-4 py-4">
                  <Markdown>{activeReview.aiSummary}</Markdown>
                </div>
              )}
            </div>
          )}

          {/* Agent Plan (collapsible) — elevated card */}
          {hasPlan && (
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <button
                className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
                onClick={() => setPlanExpanded((v) => !v)}
              >
                {planExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                Agent Plan
              </button>
              {planExpanded && (
                <div className="border-t px-4 py-4">
                  <Markdown>{activeReview.planMarkdown!}</Markdown>
                </div>
              )}
            </div>
          )}

          {/* Plan-only empty state */}
          {!hasDiff && hasPlan && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">
              No code changes — this is a plan-only review
            </div>
          )}

          {/* Code Changes — elevated card */}
          {hasDiff && (
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b">
                <h3 className="text-sm font-medium">Code Changes</h3>
              </div>
              <div className="grid grid-cols-[200px_1fr] gap-0">
                <div className="border-r p-3 bg-muted/20">
                  <FileTree
                    files={diffFiles}
                    selectedFile={selectedFile}
                    onSelectFile={setSelectedFile}
                  />
                </div>
                <div className="p-3">
                  <DiffView
                    files={
                      selectedFile
                        ? diffFiles.filter((f) => f.path === selectedFile)
                        : diffFiles
                    }
                    comments={inlineComments}
                    onAddComment={isPending ? handleAddComment : undefined}
                    readOnly={!isPending}
                  />
                </div>
              </div>
            </div>
          )}

          {/* No diff and no plan */}
          {!hasDiff && !hasPlan && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
              No changes to review
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
