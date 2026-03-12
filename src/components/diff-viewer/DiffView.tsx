"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/services/diff-service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronRight,
  ChevronDown,
  FilePlus,
  FileEdit,
  FileMinus,
  FileSymlink,
  MessageSquarePlus,
  Send,
} from "lucide-react";

export interface InlineComment {
  filePath: string;
  lineNumber: number | null;
  side: "left" | "right" | null;
  body: string;
}

interface DiffViewProps {
  files: DiffFile[];
  comments?: Array<{
    id: string;
    filePath: string;
    lineNumber: number | null;
    side: string | null;
    body: string;
  }>;
  onAddComment?: (comment: InlineComment) => void;
  readOnly?: boolean;
}

export function DiffView({
  files,
  comments = [],
  onAddComment,
  readOnly = false,
}: DiffViewProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    new Set(files.map((f) => f.path))
  );
  const [commentingAt, setCommentingAt] = useState<{
    file: string;
    line: number | null;
    side: "left" | "right" | null;
  } | null>(null);
  const [commentText, setCommentText] = useState("");

  function toggleFile(path: string) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function startComment(
    file: string,
    line: number | null,
    side: "left" | "right" | null
  ) {
    setCommentingAt({ file, line, side });
    setCommentText("");
  }

  function submitComment() {
    if (!commentingAt || !commentText.trim() || !onAddComment) return;
    onAddComment({
      filePath: commentingAt.file,
      lineNumber: commentingAt.line,
      side: commentingAt.side,
      body: commentText.trim(),
    });
    setCommentingAt(null);
    setCommentText("");
  }

  const statusIcon = {
    added: <FilePlus className="h-4 w-4 text-green-600" />,
    modified: <FileEdit className="h-4 w-4 text-yellow-600" />,
    deleted: <FileMinus className="h-4 w-4 text-red-600" />,
    renamed: <FileSymlink className="h-4 w-4 text-blue-600" />,
  };

  return (
    <div className="space-y-2">
      {files.map((file) => {
        const isExpanded = expandedFiles.has(file.path);
        const fileComments = comments.filter(
          (c) => c.filePath === file.path
        );

        return (
          <div key={file.path} className="border rounded-lg overflow-hidden">
            {/* File header */}
            <button
              className="flex items-center gap-2 w-full px-3 py-2 bg-muted/50 hover:bg-muted text-left text-sm font-mono"
              onClick={() => toggleFile(file.path)}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              {statusIcon[file.status]}
              <span className="flex-1 truncate">{file.path}</span>
              <span className="text-green-600 text-xs">+{file.additions}</span>
              <span className="text-red-600 text-xs">-{file.deletions}</span>
            </button>

            {/* Diff content */}
            {isExpanded && (
              <div>
                <div className="text-xs font-mono">
                  {file.hunks.map((hunk, hi) => (
                    <div key={hi}>
                      {/* Hunk header */}
                      <div className="px-3 py-1 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-xs">
                        {hunk.header}
                      </div>
                      {/* Lines */}
                      {hunk.lines.map((line, li) => {
                        const lineKey = `${file.path}:${line.newLineNumber ?? line.oldLineNumber}`;
                        const lineComments = fileComments.filter(
                          (c) =>
                            c.lineNumber ===
                            (line.newLineNumber ?? line.oldLineNumber)
                        );
                        const isCommenting =
                          commentingAt?.file === file.path &&
                          commentingAt?.line ===
                            (line.newLineNumber ?? line.oldLineNumber);

                        return (
                          <div key={li}>
                            <div
                              className={cn(
                                "group flex hover:bg-muted/50",
                                line.type === "add" &&
                                  "bg-green-50 dark:bg-green-950/30",
                                line.type === "delete" &&
                                  "bg-red-50 dark:bg-red-950/30"
                              )}
                            >
                              {/* Comment button — left gutter */}
                              <div className="w-6 shrink-0 flex items-center justify-center">
                                {!readOnly && onAddComment ? (
                                  <button
                                    className="opacity-0 group-hover:opacity-100 text-blue-500 hover:text-blue-700"
                                    onClick={() =>
                                      startComment(
                                        file.path,
                                        line.newLineNumber ??
                                          line.oldLineNumber ??
                                          null,
                                        line.type === "delete"
                                          ? "left"
                                          : "right"
                                      )
                                    }
                                    title="Add comment"
                                  >
                                    <MessageSquarePlus className="h-3 w-3" />
                                  </button>
                                ) : null}
                              </div>
                              {/* Line numbers */}
                              <div className="w-12 shrink-0 text-right pr-2 text-muted-foreground select-none border-r">
                                {line.oldLineNumber ?? ""}
                              </div>
                              <div className="w-12 shrink-0 text-right pr-2 text-muted-foreground select-none border-r">
                                {line.newLineNumber ?? ""}
                              </div>
                              {/* Line type indicator */}
                              <div className="w-6 shrink-0 text-center select-none">
                                {line.type === "add" && (
                                  <span className="text-green-600">+</span>
                                )}
                                {line.type === "delete" && (
                                  <span className="text-red-600">-</span>
                                )}
                              </div>
                              {/* Content */}
                              <pre className="flex-1 px-2 whitespace-pre-wrap break-all">
                                {line.content}
                              </pre>
                            </div>

                            {/* Existing comments */}
                            {lineComments.map((c) => (
                              <div
                                key={c.id}
                                className="ml-[6.5rem] mr-4 my-1 p-2 rounded border bg-yellow-50 dark:bg-yellow-950/20 text-xs"
                              >
                                <p className="whitespace-pre-wrap">{c.body}</p>
                              </div>
                            ))}

                            {/* Comment form */}
                            {isCommenting && (
                              <div className="ml-[6.5rem] mr-4 my-2 space-y-2">
                                <Textarea
                                  value={commentText}
                                  onChange={(e) =>
                                    setCommentText(e.target.value)
                                  }
                                  placeholder="Leave a review comment..."
                                  className="text-xs min-h-[60px]"
                                  autoFocus
                                />
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    onClick={submitComment}
                                    disabled={!commentText.trim()}
                                  >
                                    <Send className="mr-1 h-3 w-3" />
                                    Comment
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setCommentingAt(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
