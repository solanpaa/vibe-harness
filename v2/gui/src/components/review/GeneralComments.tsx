import { useState, useCallback } from "react";
import type { ReviewComment, CreateReviewCommentRequest } from "@vibe-harness/shared";

interface GeneralCommentsProps {
  comments: ReviewComment[];
  onAddComment: (data: CreateReviewCommentRequest) => void;
  readOnly?: boolean;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export function GeneralComments({ comments, onAddComment, readOnly }: GeneralCommentsProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // General comments have no filePath
  const generalComments = comments.filter((c) => !c.filePath);

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      onAddComment({ body: trimmed });
      setBody("");
    } finally {
      setSubmitting(false);
    }
  }, [body, submitting, onAddComment]);

  return (
    <div className="space-y-3">
      {/* Existing comments */}
      {generalComments.length > 0 && (
        <div className="space-y-2">
          {generalComments.map((comment) => (
            <div
              key={comment.id}
              className="bg-zinc-800/30 rounded-lg px-4 py-3 text-sm"
            >
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                <span>💬</span>
                <span>{formatTime(comment.createdAt)}</span>
              </div>
              <p className="text-zinc-300 whitespace-pre-wrap">{comment.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* New comment form */}
      {!readOnly && (
        <div className="flex gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a general comment..."
            rows={2}
            className="flex-1 bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            className="self-end px-3 py-2 text-xs rounded-md bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "..." : "Comment"}
          </button>
        </div>
      )}
    </div>
  );
}
