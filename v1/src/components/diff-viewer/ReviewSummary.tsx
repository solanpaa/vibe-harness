"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";
import { reviewStatusConfig } from "@/lib/status-config";

interface ReviewSummaryProps {
  summary: string;
  round: number;
  status: string;
}

export function ReviewSummary({ summary, round, status }: ReviewSummaryProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">AI Summary</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Round {round}</Badge>
            <Badge className={reviewStatusConfig[status]?.colorClass || ""}>
              {reviewStatusConfig[status]?.label ?? status.replace("_", " ")}
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
