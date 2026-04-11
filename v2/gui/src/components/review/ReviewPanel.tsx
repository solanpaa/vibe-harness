import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import { useWorkspaceStore } from "../../stores/workspace";
import { ReviewHeader } from "./ReviewHeader";
import { FileTree } from "./FileTree";
import { DiffViewer } from "./DiffViewer";
import { GeneralComments } from "./GeneralComments";
import type {
  Review,
  ReviewComment,
  ReviewDetailResponse,
  DiffFile,
  CreateReviewCommentRequest,
} from "@vibe-harness/shared";

interface ReviewPanelProps {
  reviewId: string;
  runId: string;
  onBack: () => void;
}

/** Parse the raw unified diff string into structured DiffFile objects. */
function parseDiffSnapshot(raw: string | null): DiffFile[] {
  if (!raw) return [];

  const files: DiffFile[] = [];
  // Split by "diff --git" boundaries
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    if (lines.length === 0) continue;

    // Parse file header: "a/path b/path"
    const headerMatch = lines[0].match(/a\/(.+?)\s+b\/(.+)/);
    const oldPath = headerMatch?.[1] ?? null;
    const newPath = headerMatch?.[2] ?? null;

    let status: DiffFile["status"] = "modified";
    let isBinary = false;

    for (const line of lines.slice(1, 10)) {
      if (line.startsWith("new file")) status = "added";
      else if (line.startsWith("deleted file")) status = "deleted";
      else if (line.startsWith("rename from")) status = "renamed";
      else if (line.includes("Binary files")) isBinary = true;
    }

    const hunks: DiffFile["hunks"] = [];
    let additions = 0;
    let deletions = 0;

    // Find hunks
    for (let i = 1; i < lines.length; i++) {
      const hunkMatch = lines[i].match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
      );
      if (!hunkMatch) continue;

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] ?? "1", 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] ?? "1", 10);
      const context = hunkMatch[5]?.trim() || undefined;

      const hunkLines: DiffFile["hunks"][0]["lines"] = [];
      let oldLine = oldStart;
      let newLine = newStart;

      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.startsWith("@@ ") || l.startsWith("diff --git ")) break;
        if (l.startsWith("\\ No newline")) continue;

        if (l.startsWith("+")) {
          hunkLines.push({
            type: "add",
            content: l.slice(1),
            oldLineNumber: null,
            newLineNumber: newLine++,
          });
          additions++;
        } else if (l.startsWith("-")) {
          hunkLines.push({
            type: "delete",
            content: l.slice(1),
            oldLineNumber: oldLine++,
            newLineNumber: null,
          });
          deletions++;
        } else {
          // Context line (starts with space or is empty)
          hunkLines.push({
            type: "context",
            content: l.startsWith(" ") ? l.slice(1) : l,
            oldLineNumber: oldLine++,
            newLineNumber: newLine++,
          });
        }
      }

      hunks.push({
        header: lines[i],
        oldStart,
        oldCount,
        newStart,
        newCount,
        context,
        lines: hunkLines,
      });
    }

    files.push({
      oldPath: status === "added" ? null : oldPath,
      newPath: status === "deleted" ? null : newPath,
      status,
      isBinary,
      hunks,
      additions,
      deletions,
    });
  }

  return files;
}

export function ReviewPanel({ reviewId, runId, onBack }: ReviewPanelProps) {
  const { client } = useDaemonStore();
  const { updateRun } = useWorkspaceStore();

  const [detail, setDetail] = useState<ReviewDetailResponse | null>(null);
  const [allReviews, setAllReviews] = useState<Review[]>([]);
  const [selectedRound, setSelectedRound] = useState<number>(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [localComments, setLocalComments] = useState<ReviewComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [showSummary, setShowSummary] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  const [actionResult, setActionResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Fetch review detail + all reviews for round selector
  useEffect(() => {
    if (!client) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      client.getReview(reviewId),
      client.listReviews(runId),
    ])
      .then(([reviewDetail, reviewList]) => {
        if (cancelled) return;
        setDetail(reviewDetail);
        setLocalComments(reviewDetail.comments);
        setAllReviews(reviewList.reviews);
        setSelectedRound(reviewDetail.review.round);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load review");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, reviewId, runId]);

  // Switch rounds: load different review
  const handleSelectRound = useCallback(
    async (round: number) => {
      if (!client || round === selectedRound) return;
      const target = allReviews.find((r) => r.round === round);
      if (!target) return;

      setSelectedRound(round);
      setLoading(true);
      try {
        const d = await client.getReview(target.id);
        setDetail(d);
        setLocalComments(d.comments);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load round");
      } finally {
        setLoading(false);
      }
    },
    [client, selectedRound, allReviews]
  );

  // Parse diff files from the snapshot
  const diffFiles = detail?.review.diffSnapshot
    ? parseDiffSnapshot(detail.review.diffSnapshot)
    : [];

  const isPending = detail?.review.status === "pending_review";

  const handleAddComment = useCallback(
    async (data: CreateReviewCommentRequest) => {
      if (!client || !detail) return;
      try {
        const comment = await client.addComment(detail.review.id, data);
        setLocalComments((prev) => [...prev, comment]);
      } catch (err) {
        console.error("Failed to add comment:", err);
      }
    },
    [client, detail]
  );

  const handleApprove = useCallback(async () => {
    if (!client || !detail || approving) return;
    setApproving(true);
    setActionResult(null);
    try {
      const res = await client.approveReview(detail.review.id);
      setDetail((prev) =>
        prev ? { ...prev, review: res.review } : prev
      );
      updateRun(runId, { status: res.status });
      setActionResult({
        type: "success",
        message: res.nextStage
          ? `Approved! Advancing to stage: ${res.nextStage}`
          : "Approved! Workflow completing.",
      });
    } catch (err) {
      setActionResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to approve",
      });
    } finally {
      setApproving(false);
    }
  }, [client, detail, approving, runId, updateRun]);

  const handleRequestChanges = useCallback(async () => {
    if (!client || !detail || requesting) return;

    // Must have at least one comment
    if (localComments.length === 0) {
      setActionResult({
        type: "error",
        message: "Add at least one comment before requesting changes.",
      });
      return;
    }

    setRequesting(true);
    setActionResult(null);
    try {
      const pendingComments = localComments.map((c) => ({
        body: c.body,
        filePath: c.filePath ?? undefined,
        lineNumber: c.lineNumber ?? undefined,
        side: c.side ?? undefined,
      }));
      const res = await client.requestChanges(detail.review.id, pendingComments);
      setDetail((prev) =>
        prev ? { ...prev, review: res.review } : prev
      );
      updateRun(runId, { status: "running" as const });
      setActionResult({
        type: "success",
        message: "Changes requested. Agent is re-running the stage.",
      });
    } catch (err) {
      setActionResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to request changes",
      });
    } finally {
      setRequesting(false);
    }
  }, [client, detail, requesting, localComments, runId, updateRun]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading review...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <span className="text-red-400 text-sm">Error: {error}</span>
        <button
          onClick={onBack}
          className="text-xs text-zinc-400 hover:text-zinc-200"
        >
          ← Back to run
        </button>
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Review header */}
      <div className="flex-shrink-0 pb-3 border-b border-zinc-700/50">
        <ReviewHeader
          review={detail.review}
          reviews={allReviews}
          selectedRound={selectedRound}
          runId={runId}
          onSelectRound={handleSelectRound}
          onApprove={handleApprove}
          onRequestChanges={handleRequestChanges}
          onBack={onBack}
          canApprove={isPending}
          canRequestChanges={isPending}
          approving={approving}
          requesting={requesting}
        />
      </div>

      {/* Action result banner */}
      {actionResult && (
        <div
          className={`flex-shrink-0 px-4 py-2 text-sm ${
            actionResult.type === "success"
              ? "bg-green-950/30 text-green-300 border-b border-green-500/20"
              : "bg-red-950/30 text-red-300 border-b border-red-500/20"
          }`}
        >
          {actionResult.message}
        </div>
      )}

      {/* AI Summary (collapsible) */}
      {detail.review.aiSummary && (
        <div className="flex-shrink-0 border-b border-zinc-700/30">
          <button
            onClick={() => setShowSummary((s) => !s)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span className="font-semibold uppercase tracking-wide">
              AI Summary
            </span>
            <span>{showSummary ? "▼" : "▶"}</span>
          </button>
          {showSummary && (
            <div className="px-4 pb-3 text-sm text-zinc-300 whitespace-pre-wrap">
              {detail.review.aiSummary}
            </div>
          )}
        </div>
      )}

      {/* Plan markdown (collapsible) */}
      {detail.review.planMarkdown && (
        <div className="flex-shrink-0 border-b border-zinc-700/30">
          <button
            onClick={() => setShowPlan((s) => !s)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span className="font-semibold uppercase tracking-wide">
              Plan
            </span>
            <span>{showPlan ? "▼" : "▶"}</span>
          </button>
          {showPlan && (
            <div className="px-4 pb-3 text-sm text-zinc-300 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
              {detail.review.planMarkdown}
            </div>
          )}
        </div>
      )}

      {/* Diff area: file tree + diff viewer */}
      <div className="flex-1 flex overflow-hidden">
        {/* File tree sidebar */}
        {diffFiles.length > 0 && (
          <div className="w-56 flex-shrink-0 border-r border-zinc-700/30 overflow-hidden">
            <FileTree
              files={diffFiles}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
            />
          </div>
        )}

        {/* Diff viewer */}
        <div className="flex-1 overflow-hidden">
          <DiffViewer
            files={diffFiles}
            selectedFile={selectedFile}
            comments={localComments}
            onAddComment={isPending ? handleAddComment : undefined}
            readOnly={!isPending}
          />
        </div>
      </div>

      {/* General comments section */}
      <div className="flex-shrink-0 border-t border-zinc-700/30 p-4 max-h-48 overflow-y-auto">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
          Comments
        </h3>
        <GeneralComments
          comments={localComments}
          onAddComment={handleAddComment}
          readOnly={!isPending}
        />
      </div>
    </div>
  );
}
