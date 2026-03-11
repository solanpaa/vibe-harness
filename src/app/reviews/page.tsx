"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitPullRequestArrow, Check, MessageSquare, Clock } from "lucide-react";

interface Review {
  id: string;
  sessionId: string;
  round: number;
  status: string;
  aiSummary: string | null;
  createdAt: string;
}

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);

  useEffect(() => {
    fetch("/api/reviews")
      .then((r) => r.json())
      .then(setReviews);
  }, []);

  const statusColors: Record<string, string> = {
    pending_review: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    changes_requested: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    approved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  };

  const statusIcons: Record<string, React.ReactNode> = {
    approved: <Check className="h-4 w-4" />,
    changes_requested: <MessageSquare className="h-4 w-4" />,
    pending_review: <Clock className="h-4 w-4" />,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reviews</h1>
        <p className="text-muted-foreground">
          Review AI-generated changes with inline comments — like a local PR review
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
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
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
                          {review.status.replace("_", " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(review.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {review.aiSummary && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {review.aiSummary.slice(0, 200)}...
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
