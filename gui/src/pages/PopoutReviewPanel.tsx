// ---------------------------------------------------------------------------
// Pop-out Review Panel Page (CDD-gui §9)
//
// Standalone page for /run/:runId/review/:reviewId.
// Shows a review in a dedicated pop-out window.
// ---------------------------------------------------------------------------

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useDaemonStore } from '../stores/daemon';
import { PopoutLayout } from '../components/shared/PopoutLayout';
import { StatusBadge } from '../components/shared/StatusBadge';

interface ReviewDetail {
  id: string;
  runId: string;
  stageName: string;
  status: string;
  round: number;
  diff?: string;
  summary?: string;
  createdAt: string;
}

export function PopoutReviewPanel() {
  const { runId, reviewId } = useParams<{ runId: string; reviewId: string }>();
  const { client } = useDaemonStore();
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !runId || !reviewId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Fetch run detail — reviews are embedded in stages
    client
      .getRun(runId)
      .then((detail) => {
        if (cancelled) return;

        // Find the review across all stages
        for (const stage of detail.stages) {
          if (stage.id === reviewId) {
            setReview({
              id: stage.id,
              runId: detail.id,
              stageName: stage.stageName,
              status: stage.status,
              round: stage.round,
              createdAt: stage.startedAt ?? detail.createdAt,
            });
            return;
          }
        }
        setError('Review not found');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? 'Failed to load review');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, runId, reviewId]);

  if (!runId || !reviewId) {
    return (
      <PopoutLayout title="Review">
        <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
          Missing run or review ID
        </div>
      </PopoutLayout>
    );
  }

  if (loading) {
    return (
      <PopoutLayout title="Review">
        <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
          Loading review...
        </div>
      </PopoutLayout>
    );
  }

  if (error || !review) {
    return (
      <PopoutLayout title="Review">
        <div className="flex items-center justify-center h-full text-red-400 text-sm">
          {error ?? 'Review not found'}
        </div>
      </PopoutLayout>
    );
  }

  return (
    <PopoutLayout title={`Review — ${review.stageName} (Round ${review.round})`}>
      <div className="flex flex-col gap-4 h-full overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-200">
              {review.stageName}
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Round {review.round} · {review.id.slice(0, 8)}
            </p>
          </div>
          <StatusBadge status={review.status} size="md" />
        </div>

        {review.summary && (
          <div className="bg-zinc-800/30 rounded-lg p-4">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
              Summary
            </h3>
            <p className="text-sm text-zinc-300 whitespace-pre-wrap">
              {review.summary}
            </p>
          </div>
        )}

        {review.diff && (
          <div className="bg-zinc-800/30 rounded-lg p-4">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
              Diff
            </h3>
            <pre className="text-xs text-zinc-300 font-mono whitespace-pre overflow-x-auto">
              {review.diff}
            </pre>
          </div>
        )}
      </div>
    </PopoutLayout>
  );
}
