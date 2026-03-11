"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DiffView, type InlineComment } from "@/components/diff-viewer/DiffView";
import { FileTree } from "@/components/diff-viewer/FileTree";
import { ReviewSummary } from "@/components/diff-viewer/ReviewSummary";
import { parseUnifiedDiff } from "@/lib/services/diff-service";
import type { DiffFile } from "@/lib/services/diff-service";
import { ArrowLeft, Check, MessageSquare, History } from "lucide-react";
import { toast } from "sonner";

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

export default function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [files, setFiles] = useState<DiffFile[]>([]);

  useEffect(() => {
    // Load review
    fetch(`/api/reviews/${id}`)
      .then((r) => r.json())
      .then((data: Review) => {
        setReview(data);
        if (data.diffSnapshot) {
          setFiles(parseUnifiedDiff(data.diffSnapshot));
        }
      });

    // Load comments
    fetch(`/api/reviews/${id}/comments`)
      .then((r) => r.json())
      .then(setComments);
  }, [id]);

  async function handleAddComment(comment: InlineComment) {
    const res = await fetch(`/api/reviews/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment),
    });
    if (res.ok) {
      const newComment = await res.json();
      setComments((prev) => [...prev, newComment]);
      toast.success("Comment added");
    }
  }

  async function handleSubmit(action: "approve" | "request_changes") {
    const res = await fetch(`/api/reviews/${id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      const result = await res.json();
      setReview((prev) => prev ? { ...prev, status: result.status } : null);
      if (action === "approve") {
        if (result.merged) {
          toast.success("Changes approved and merged!");
        } else if (result.mergeError) {
          toast.success("Changes approved! Merge failed — merge the branch manually.", {
            duration: 6000,
          });
        } else {
          toast.success("Changes approved!");
        }
        if (result.workflowAdvanced?.nextStage) {
          toast.info(`Workflow advancing to stage: ${result.workflowAdvanced.nextStage}`);
        } else if (result.workflowAdvanced?.completed) {
          toast.success("Workflow completed!");
        }
      } else {
        toast.success("Changes requested — new agent run will be spawned");
      }
    }
  }

  if (!review) {
    return <div className="text-muted-foreground">Loading review...</div>;
  }

  const isPending = review.status === "pending_review";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/reviews")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Reviews
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/reviews/${id}/history`)}
        >
          <History className="h-4 w-4 mr-1" />
          View History
        </Button>
      </div>

      {/* AI Summary */}
      <ReviewSummary
        summary={review.aiSummary || "No summary available"}
        round={review.round}
        status={review.status}
      />

      {/* Agent's Plan */}
      {review.planMarkdown && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Agent Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {review.planMarkdown.split("\n").map((line, i) => {
                if (line.startsWith("## ")) {
                  return (
                    <h2 key={i} className="text-base font-semibold mt-4 mb-2">
                      {line.slice(3)}
                    </h2>
                  );
                }
                if (line.startsWith("### ")) {
                  return (
                    <h3 key={i} className="text-sm font-semibold mt-3 mb-1">
                      {line.slice(4)}
                    </h3>
                  );
                }
                if (line.startsWith("# ")) {
                  return (
                    <h1 key={i} className="text-lg font-bold mt-4 mb-2">
                      {line.slice(2)}
                    </h1>
                  );
                }
                if (line.startsWith("- ")) {
                  return (
                    <li key={i} className="text-sm ml-4">
                      {line.slice(2)}
                    </li>
                  );
                }
                if (line.startsWith("```")) {
                  return null;
                }
                if (line.trim() === "") return <br key={i} />;
                return (
                  <p key={i} className="text-sm">
                    {line}
                  </p>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      {isPending && (
        <div className="flex items-center gap-3">
          <Button
            onClick={() => handleSubmit("approve")}
            className="bg-green-600 hover:bg-green-700"
          >
            <Check className="mr-2 h-4 w-4" />
            Approve Changes
          </Button>
          <Button
            variant="outline"
            onClick={() => handleSubmit("request_changes")}
            disabled={comments.length === 0}
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            Request Changes ({comments.length} comments)
          </Button>
          {comments.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Add inline comments on the diff below before requesting changes
            </span>
          )}
        </div>
      )}

      <Separator />

      {/* Diff viewer */}
      <div className="grid grid-cols-[250px_1fr] gap-4">
        <FileTree files={files} />
        <DiffView
          files={files}
          comments={comments}
          onAddComment={isPending ? handleAddComment : undefined}
          readOnly={!isPending}
        />
      </div>
    </div>
  );
}
