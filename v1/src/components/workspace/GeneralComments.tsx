"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send, Trash2 } from "lucide-react";

export const GENERAL_COMMENT_FILE_PATH = "__general__";

export interface GeneralComment {
  id: string;
  body: string;
  createdAt: string;
}

interface GeneralCommentsProps {
  comments: GeneralComment[];
  onAddComment: (body: string) => void;
  onDeleteComment?: (id: string) => void;
  readOnly?: boolean;
}

export function GeneralComments({
  comments,
  onAddComment,
  onDeleteComment,
  readOnly = false,
}: GeneralCommentsProps) {
  const [drafting, setDrafting] = useState(false);
  const [text, setText] = useState("");

  function handleSubmit() {
    if (!text.trim()) return;
    onAddComment(text.trim());
    setText("");
    setDrafting(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-1.5">
          <MessageSquare className="h-4 w-4" />
          General Comments
          {comments.length > 0 && (
            <span className="text-muted-foreground">({comments.length})</span>
          )}
        </h3>
        {!readOnly && !drafting && (
          <Button size="sm" variant="outline" onClick={() => setDrafting(true)}>
            Add Comment
          </Button>
        )}
      </div>

      {/* Existing comments */}
      {comments.length > 0 && (
        <div className="space-y-2">
          {comments.map((c) => (
            <div
              key={c.id}
              className="group rounded-md border bg-muted/30 p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap flex-1">{c.body}</p>
                {!readOnly && onDeleteComment && (
                  <button
                    className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive transition-opacity"
                    onClick={() => onDeleteComment(c.id)}
                    title="Delete comment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {comments.length === 0 && readOnly && (
        <p className="text-xs text-muted-foreground">No general comments</p>
      )}

      {/* Draft form */}
      {drafting && (
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Leave a general comment about this review..."
            className="min-h-[80px] text-sm"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={!text.trim()}>
              <Send className="mr-1 h-3 w-3" />
              Comment
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDrafting(false);
                setText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
