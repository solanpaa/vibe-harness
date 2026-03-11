"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";

interface ReviewSummaryProps {
  summary: string;
  round: number;
  status: string;
}

export function ReviewSummary({ summary, round, status }: ReviewSummaryProps) {
  const statusColors: Record<string, string> = {
    pending_review: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    changes_requested: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    approved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">AI Summary</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Round {round}</Badge>
            <Badge className={statusColors[status] || ""}>
              {status.replace("_", " ")}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Markdown>{summary}</Markdown>
      </CardContent>
    </Card>
  );
}
