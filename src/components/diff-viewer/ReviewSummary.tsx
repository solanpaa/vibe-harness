"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
        <div className="prose prose-sm dark:prose-invert max-w-none">
          {summary.split("\n").map((line, i) => {
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
            if (line.startsWith("- ")) {
              return (
                <li key={i} className="text-sm ml-4">
                  {line.slice(2)}
                </li>
              );
            }
            if (line.startsWith("**")) {
              const content = line.replace(/\*\*/g, "");
              return (
                <p key={i} className="text-sm font-medium">
                  {content}
                </p>
              );
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
  );
}
