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
  sessionId: string;
  round: number;
  status: string;
  aiSummary: string | null;
  createdAt: string;
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

  useEffect(() => {
    fetch("/api/reviews")
      .then((r) => r.json())
      .then(setReviews)
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reviews</h1>
        <p className="text-muted-foreground">
          Review AI-generated changes with inline comments — like a local PR
          review
        </p>
      </div>

      {reviews.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <GitPullRequestArrow className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No reviews yet.</p>
              <p className="text-sm">
                Reviews are created automatically when agent sessions complete.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .map((review) => (
              <Link key={review.id} href={`/reviews/${review.id}`}>
                <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
                  <CardHeader className="py-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {statusIcons[review.status]}
                        <CardTitle className="text-base">
                          Review Round {review.round}
                        </CardTitle>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={statusColors[review.status] || ""}>
                          {review.status.replaceAll("_", " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {relativeTime(review.createdAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={(e) => handleDelete(e, review)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <ExternalLink className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    {review.aiSummary && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {review.aiSummary.slice(0, 200)}
                      </p>
                    )}
                  </CardHeader>
                </Card>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
