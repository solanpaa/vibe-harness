"use client";

import { cn } from "@/lib/utils";
import { statusDotClass, reviewStatusConfig } from "@/lib/status-config";

export interface ReviewFeedItemProps {
  reviewId: string;
  round: number;
  status: string;
  isSelected: boolean;
  isNested?: boolean;
  onClick: () => void;
}

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
      <span className="size-3 shrink-0 text-[11px] leading-3 text-center text-muted-foreground/60">★</span>
      <span className="text-[12px] text-muted-foreground/70">
        Review{round > 1 ? ` · R${round}` : ""}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <span className={cn("size-1.5 rounded-full", statusDotClass[status] ?? "bg-gray-400")} />
        <span className="text-[11px] text-muted-foreground">
          {reviewStatusConfig[status]?.label ?? status.replace(/_/g, " ")}
        </span>
      </span>
    </button>
  );
}
