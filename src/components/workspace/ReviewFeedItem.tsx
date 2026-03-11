"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface ReviewFeedItemProps {
  reviewId: string;
  round: number;
  status: string;
  isSelected: boolean;
  isNested?: boolean;
  onClick: () => void;
}

const statusBadgeClass: Record<string, string> = {
  pending_review:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  approved:
    "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  changes_requested:
    "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
};

const statusLabel: Record<string, string> = {
  pending_review: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
};

export function ReviewFeedItem({
  round,
  status,
  isSelected,
  isNested = true,
  onClick,
}: ReviewFeedItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
        isNested ? "pl-4" : "pl-2",
        isSelected ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <Star className="size-4 shrink-0 text-amber-500 fill-amber-500/20" />
      <span className="text-sm font-medium">Review</span>
      {round > 1 && (
        <span className="text-xs text-muted-foreground">
          Round {round}
        </span>
      )}
      <Badge
        variant="secondary"
        className={cn(
          "ml-auto shrink-0 text-[10px] leading-tight",
          statusBadgeClass[status] ?? "",
        )}
      >
        {statusLabel[status] ?? status.replace(/_/g, " ")}
      </Badge>
    </button>
  );
}
