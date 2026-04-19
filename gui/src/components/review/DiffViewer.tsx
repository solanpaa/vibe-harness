import { useRef, useCallback } from "react";
import type { DiffFile, DiffHunk, DiffLine, ReviewComment, CreateReviewCommentRequest } from "@vibe-harness/shared";
import { InlineComment } from "./InlineComment";

interface DiffViewerProps {
  files: DiffFile[];
  selectedFile: string | null;
  comments: ReviewComment[];
  onAddComment?: (data: CreateReviewCommentRequest) => void;
  readOnly?: boolean;
}

function getFilePath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "unknown";
}

function HunkView({
  hunk,
  filePath,
  comments,
  onAddComment,
  readOnly,
}: {
  hunk: DiffHunk;
  filePath: string;
  comments: ReviewComment[];
  onAddComment?: (data: CreateReviewCommentRequest) => void;
  readOnly?: boolean;
}) {
  return (
    <div>
      {/* Hunk header */}
      <div className="bg-blue-950/30 text-blue-300 text-xs font-mono px-4 py-1 select-none">
        {hunk.header}
        {hunk.context && <span className="text-blue-400/60 ml-2">{hunk.context}</span>}
      </div>

      {/* Lines */}
      {hunk.lines.map((line, idx) => {
        const lineComments = comments.filter(
          (c) =>
            c.filePath === filePath &&
            c.lineNumber === (line.newLineNumber ?? line.oldLineNumber)
        );

        return (
          <LineView
            key={idx}
            line={line}
            filePath={filePath}
            comments={lineComments}
            onAddComment={onAddComment}
            readOnly={readOnly}
          />
        );
      })}
    </div>
  );
}

function LineView({
  line,
  filePath,
  comments,
  onAddComment,
  readOnly,
}: {
  line: DiffLine;
  filePath: string;
  comments: ReviewComment[];
  onAddComment?: (data: CreateReviewCommentRequest) => void;
  readOnly?: boolean;
}) {
  const bgClass =
    line.type === "add"
      ? "bg-green-950/20"
      : line.type === "delete"
        ? "bg-red-950/20"
        : "";

  const textClass =
    line.type === "add"
      ? "text-green-300"
      : line.type === "delete"
        ? "text-red-300"
        : "text-zinc-400";

  const prefix =
    line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";

  const lineNum = line.newLineNumber ?? line.oldLineNumber;

  const handleGutterClick = useCallback(() => {
    if (readOnly || !onAddComment || !lineNum) return;
    const body = prompt("Add comment:");
    if (body?.trim()) {
      onAddComment({
        filePath,
        lineNumber: lineNum,
        side: line.type === "delete" ? "left" : "right",
        body: body.trim(),
      });
    }
  }, [readOnly, onAddComment, lineNum, filePath, line.type]);

  return (
    <>
      <div className={`flex font-mono text-xs group ${bgClass}`}>
        {/* Old line number */}
        <span className="w-12 text-right pr-2 text-zinc-600 select-none flex-shrink-0 py-px">
          {line.oldLineNumber ?? ""}
        </span>
        {/* New line number */}
        <span className="w-12 text-right pr-2 text-zinc-600 select-none flex-shrink-0 py-px">
          {line.newLineNumber ?? ""}
        </span>
        {/* Gutter for comments */}
        {!readOnly && onAddComment && (
          <button
            onClick={handleGutterClick}
            className="w-5 flex-shrink-0 text-center opacity-0 group-hover:opacity-100 text-blue-400 hover:text-blue-300 transition-opacity py-px"
            title="Add comment"
          >
            +
          </button>
        )}
        {/* Content */}
        <span className={`flex-1 px-2 whitespace-pre-wrap break-all py-px ${textClass}`}>
          {prefix}{line.content}
        </span>
      </div>

      {/* Inline comments */}
      {comments.map((comment) => (
        <InlineComment key={comment.id} comment={comment} />
      ))}
    </>
  );
}

export function DiffViewer({
  files,
  selectedFile,
  comments,
  onAddComment,
  readOnly,
}: DiffViewerProps) {
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setFileRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) {
        fileRefs.current.set(path, el);
        // Auto-scroll when selectedFile changes
        if (path === selectedFile) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } else {
        fileRefs.current.delete(path);
      }
    },
    [selectedFile]
  );

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        No changes to display
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      {files.map((file) => {
        const path = getFilePath(file);
        const fileComments = comments.filter((c) => c.filePath === path);

        return (
          <div
            key={path}
            ref={setFileRef(path)}
            className="mb-4 border border-zinc-700/30 rounded-lg overflow-hidden"
          >
            {/* File header */}
            <div className="flex items-center justify-between bg-zinc-800/50 px-4 py-2 border-b border-zinc-700/30">
              <div className="flex items-center gap-2 min-w-0">
                <FileStatusIcon status={file.status} />
                <span className="font-mono text-sm text-zinc-200 truncate">
                  {file.status === "renamed"
                    ? `${file.oldPath} → ${file.newPath}`
                    : path}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs flex-shrink-0">
                {file.additions > 0 && (
                  <span className="text-green-400">+{file.additions}</span>
                )}
                {file.deletions > 0 && (
                  <span className="text-red-400">-{file.deletions}</span>
                )}
              </div>
            </div>

            {/* File content */}
            {file.isBinary ? (
              <div className="px-4 py-3 text-sm text-zinc-500 italic">
                Binary file changed
              </div>
            ) : (
              <div>
                {file.hunks.map((hunk, idx) => (
                  <HunkView
                    key={idx}
                    hunk={hunk}
                    filePath={path}
                    comments={fileComments}
                    onAddComment={onAddComment}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileStatusIcon({ status }: { status: DiffFile["status"] }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    added:    { bg: "bg-green-500/20", text: "text-green-400", label: "A" },
    modified: { bg: "bg-blue-500/20",  text: "text-blue-400",  label: "M" },
    deleted:  { bg: "bg-red-500/20",   text: "text-red-400",   label: "D" },
    renamed:  { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "R" },
  };
  const c = config[status] ?? config.modified;
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  );
}
