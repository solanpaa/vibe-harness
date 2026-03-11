"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  GitPullRequestArrow,
  Check,
  MessageSquare,
  Clock,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

interface Review {
  id: string;
  taskId: string;
  round: number;
  status: string;
  aiSummary: string | null;
  createdAt: string;
}

interface TaskInfo {
  id: string;
  projectId: string;
  originTaskId: string | null;
  prompt: string;
}

interface ProjectInfo {
  id: string;
  name: string;
}

// A group of reviews that belong to the same session chain
interface ReviewGroup {
  originTaskId: string;
  projectName: string;
  prompt: string;
  reviews: Review[];
  latestReview: Review;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusColors: Record<string, string> = {
  pending_review:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  changes_requested:
    "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  approved:
    "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
};

const statusIcons: Record<string, React.ReactNode> = {
  pending_review: <Clock className="h-4 w-4" />,
  changes_requested: <MessageSquare className="h-4 w-4" />,
  approved: <Check className="h-4 w-4" />,
};

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [taskInfos, setTaskInfos] = useState<TaskInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/reviews").then((r) => r.json()),
      fetch("/api/tasks?fields=summary").then((r) => r.json()),
      fetch("/api/projects").then((r) => r.json()),
    ])
      .then(([revs, sess, projs]) => {
        setReviews(revs);
        setTaskInfos(sess);
        setProjects(projs);
      })
      .catch(() => toast.error("Failed to load reviews"));
  }, []);

  async function handleDelete(e: React.MouseEvent, review: Review) {
    e.stopPropagation();
    e.preventDefault();

    if (!window.confirm(`Delete review round ${review.round}?`)) return;

    const res = await fetch(`/api/reviews/${review.id}`, {
      method: "DELETE",
    });

    if (res.ok) {
      setReviews((prev) => prev.filter((r) => r.id !== review.id));
      toast.success("Review deleted");
    } else {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to delete review");
    }
  }

  // Build a session map for quick lookups
  const taskMap = new Map(taskInfos.map((s) => [s.id, s]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  // Group reviews by origin session chain
  const groups: Map<string, ReviewGroup> = new Map();
  for (const review of reviews) {
    const taskInfo = taskMap.get(review.taskId);
    const originId = taskInfo?.originTaskId || review.taskId;
    const originTask = taskMap.get(originId);
    const projectId = taskInfo?.projectId || originTask?.projectId;
    const project = projectId ? projectMap.get(projectId) : undefined;

    let group = groups.get(originId);
    if (!group) {
      group = {
        originTaskId: originId,
        projectName: project?.name || "Unknown project",
        prompt: originTask?.prompt || taskInfo?.prompt || "",
        reviews: [],
        latestReview: review,
      };
      groups.set(originId, group);
    }
    group.reviews.push(review);
    // Track the latest review (most recent createdAt)
    if (
      new Date(review.createdAt).getTime() >
      new Date(group.latestReview.createdAt).getTime()
    ) {
      group.latestReview = review;
    }
  }

  // Sort groups by the latest review's createdAt, descending
  const sortedGroups = Array.from(groups.values()).sort(
    (a, b) =>
      new Date(b.latestReview.createdAt).getTime() -
      new Date(a.latestReview.createdAt).getTime()
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reviews</h1>
        <p className="text-muted-foreground">
          Review AI-generated changes with inline comments — like a local PR
          review
        </p>
      </div>

      {sortedGroups.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <GitPullRequestArrow className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No reviews yet.</p>
              <p className="text-sm">
                Reviews are created automatically when agent tasks complete.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedGroups.map((group) => {
            const sortedReviews = [...group.reviews].sort(
              (a, b) => b.round - a.round
            );
            const latest = sortedReviews[0];

            return (
              <Card key={group.originTaskId}>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      {statusIcons[latest.status]}
                      <div className="min-w-0">
                        <Link href={`/tasks/${group.originTaskId}`} className="hover:underline">
                          <CardTitle className="text-base">
                            {group.projectName}
                          </CardTitle>
                        </Link>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-md">
                          {group.prompt}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link href={`/tasks/${group.originTaskId}`}>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted">
                          View Task
                        </Badge>
                      </Link>
                      <Badge variant="outline">
                        {group.reviews.length} round{group.reviews.length !== 1 ? "s" : ""}
                      </Badge>
                      <Badge className={statusColors[latest.status] || ""}>
                        {latest.status.replaceAll("_", " ")}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {relativeTime(latest.createdAt)}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-3">
                  <div className="space-y-1.5">
                    {sortedReviews.map((review) => (
                      <Link key={review.id} href={`/reviews/${review.id}`}>
                        <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer group">
                          <div className="flex items-center gap-2">
                            {statusIcons[review.status]}
                            <span className="text-sm font-medium">
                              Round {review.round}
                            </span>
                            <Badge
                              className={`text-xs ${statusColors[review.status] || ""}`}
                            >
                              {review.status.replaceAll("_", " ")}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(review.createdAt)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                              onClick={(e) => handleDelete(e, review)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
