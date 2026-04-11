import type { ReviewComment } from "@vibe-harness/shared";

interface InlineCommentProps {
  comment: ReviewComment;
}

function formatCommentTime(iso: string): string {
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

export function InlineComment({ comment }: InlineCommentProps) {
  return (
    <div className="bg-yellow-950/30 border-l-2 border-yellow-500/40 px-4 py-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
        <span>💬</span>
        {comment.filePath && (
          <span className="font-mono">{comment.filePath}:{comment.lineNumber}</span>
        )}
        <span>{formatCommentTime(comment.createdAt)}</span>
      </div>
      <p className="text-zinc-300 whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}
