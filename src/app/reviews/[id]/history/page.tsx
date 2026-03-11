"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Check, MessageSquare, Clock } from "lucide-react";

interface Review {
  id: string;
  sessionId: string;
  workflowRunId: string | null;
  round: number;
  status: string;
  aiSummary: string | null;
  createdAt: string;
}

export default function ReviewHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [currentReview, setCurrentReview] = useState<Review | null>(null);
  const [allReviews, setAllReviews] = useState<Review[]>([]);

  useEffect(() => {
    // Load the current review to get its sessionId
    fetch(`/api/reviews/${id}`)
      .then((r) => r.json())
      .then((review: Review) => {
        setCurrentReview(review);
        // Load all reviews (filter by sessionId on the client for now)
        fetch("/api/reviews")
          .then((r) => r.json())
          .then((reviews: Review[]) => {
            const related = reviews
              .filter((r) => r.sessionId === review.sessionId || r.workflowRunId === review.workflowRunId)
              .sort((a, b) => a.round - b.round);
            setAllReviews(related);
          });
      });
  }, [id]);

  const statusIcons: Record<string, React.ReactNode> = {
    approved: <Check className="h-4 w-4 text-green-600" />,
    changes_requested: <MessageSquare className="h-4 w-4 text-orange-600" />,
    pending_review: <Clock className="h-4 w-4 text-yellow-600" />,
  };

  const statusColors: Record<string, string> = {
    pending_review: "bg-yellow-100 text-yellow-800",
    changes_requested: "bg-orange-100 text-orange-800",
    approved: "bg-green-100 text-green-800",
  };

  if (!currentReview) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/reviews/${id}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Review
        </Button>
      </div>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Review History</h1>
        <p className="text-muted-foreground">
          All review rounds for this session
        </p>
      </div>

      <div className="space-y-4">
        {allReviews.map((review, index) => (
          <div key={review.id} className="flex gap-4">
            {/* Timeline line */}
            <div className="flex flex-col items-center">
              <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 bg-background">
                {statusIcons[review.status] || (
                  <Clock className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              {index < allReviews.length - 1 && (
                <div className="w-0.5 flex-1 bg-border mt-1" />
              )}
            </div>

            {/* Review card */}
            <Link href={`/reviews/${review.id}`} className="flex-1 pb-4">
              <Card
                className={`hover:border-foreground/20 transition-colors ${
                  review.id === id ? "border-primary" : ""
                }`}
              >
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      Round {review.round}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge className={statusColors[review.status] || ""}>
                        {review.status.replace("_", " ")}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(review.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                {review.aiSummary && (
                  <CardContent className="py-2">
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {review.aiSummary.slice(0, 200)}...
                    </p>
                  </CardContent>
                )}
              </Card>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
