import type { Review } from "@vibe-harness/shared";
import { StatusBadge } from "../shared/StatusBadge";
import { PopOutButton } from "../shared/PopOutButton";

interface ReviewHeaderProps {
  review: Review;
  reviews: Review[];
  selectedRound: number;
  runId: string;
  onSelectRound: (round: number) => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onBack: () => void;
  canApprove: boolean;
  canRequestChanges: boolean;
  approving?: boolean;
  requesting?: boolean;
}

export function ReviewHeader({
  review,
  reviews,
  selectedRound,
  runId,
  onSelectRound,
  onApprove,
  onRequestChanges,
  onBack,
  canApprove,
  canRequestChanges,
  approving,
  requesting,
}: ReviewHeaderProps) {
  const rounds = [...new Set(reviews.map((r) => r.round))].sort((a, b) => a - b);

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {/* Back button */}
        <button
          onClick={onBack}
          className="text-zinc-400 hover:text-zinc-200 transition-colors text-sm flex-shrink-0"
          title="Back to run detail"
        >
          ← Back
        </button>

        {/* Status badge */}
        <StatusBadge status={review.status} size="md" />

        {/* Stage name */}
        {review.stageName && (
          <span className="text-sm text-zinc-400 truncate">
            Stage: <span className="text-zinc-200">{review.stageName}</span>
          </span>
        )}

        {/* Round selector */}
        {rounds.length > 1 && (
          <div className="flex items-center gap-1">
            {rounds.map((round) => (
              <button
                key={round}
                onClick={() => onSelectRound(round)}
                className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
                  selectedRound === round
                    ? "bg-zinc-600 text-zinc-100"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
                }`}
              >
                R{round}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <PopOutButton
          route={`/run/${runId}/review/${review.id}`}
          title={`Review — ${review.stageName ?? "Review"} (Round ${review.round})`}
        />
        {canRequestChanges && (
          <button
            onClick={onRequestChanges}
            disabled={requesting}
            className="px-3 py-1.5 text-xs rounded-md border border-orange-500/30 text-orange-400 hover:bg-orange-950/50 disabled:opacity-40 transition-colors"
          >
            {requesting ? "Submitting..." : "Request Changes"}
          </button>
        )}
        {canApprove && (
          <button
            onClick={onApprove}
            disabled={approving}
            className="px-3 py-1.5 text-xs rounded-md bg-green-600 text-white hover:bg-green-500 disabled:opacity-40 transition-colors"
          >
            {approving ? "Approving..." : "Approve"}
          </button>
        )}
      </div>
    </div>
  );
}
