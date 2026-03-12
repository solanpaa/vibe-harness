import { Badge } from "@/components/ui/badge";
import { GitPullRequestArrow, History, ArrowLeft } from "lucide-react";
import { reviewStatusConfig } from "@/lib/status-config";

interface ReviewHeaderProps {
  activeReview: { round: number; status: string };
  reviews: Array<{ round: number }>;
  selectedRound: string | null;
  onSelectRound: (round: string) => void;
  onNavigateToTask: () => void;
}

export function ReviewHeader({
  activeReview,
  reviews,
  selectedRound,
  onSelectRound,
  onNavigateToTask,
}: ReviewHeaderProps) {
  return (
    <div className="p-4 pb-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitPullRequestArrow className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="text-lg font-semibold leading-tight">
              Review — Round {activeReview.round}
            </h2>
            <Badge className={reviewStatusConfig[activeReview.status]?.colorClass ?? ""}>
              {reviewStatusConfig[activeReview.status]?.label ?? activeReview.status.replace(/_/g, " ")}
            </Badge>
          </div>
          <button
            className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onNavigateToTask}
          >
            <ArrowLeft className="h-3 w-3" />
            Back to task
          </button>
        </div>

        {/* Round selector */}
        {reviews.length > 1 && (
          <div className="flex items-center gap-2 shrink-0">
            <History className="h-4 w-4 text-muted-foreground" />
            <div className="flex gap-1">
              {reviews.map((r) => (
                <button
                  key={r.round}
                  onClick={() => onSelectRound(String(r.round))}
                  className={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                    String(r.round) === selectedRound
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-muted hover:bg-muted/80 text-muted-foreground"
                  }`}
                >
                  {r.round}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
