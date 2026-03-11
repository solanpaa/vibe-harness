"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ReviewFeedItemProps {
  reviewId: string;
  round: number;
  status: string;
  isSelected: boolean;
  isNested?: boolean;
  onClick: () => void;
}

const statusDot: Record<string, string> = {
  pending_review: "bg-yellow-500",
  approved: "bg-green-500",
  changes_requested: "bg-orange-500",
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
        "flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors cursor-pointer",
        isNested ? "pl-3" : "pl-2",
        isSelected ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <Star className="size-3 shrink-0 text-amber-500 fill-amber-500/30" />
      <span className="text-[12px] text-muted-foreground">
        Review{round > 1 ? ` · R${round}` : ""}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <span className={cn("size-1.5 rounded-full", statusDot[status] ?? "bg-gray-400")} />
        <span className="text-[11px] text-muted-foreground">
          {statusLabel[status] ?? status.replace(/_/g, " ")}
        </span>
      </span>
    </button>
  );
}
