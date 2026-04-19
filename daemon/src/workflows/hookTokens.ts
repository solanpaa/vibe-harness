// ---------------------------------------------------------------------------
// Centralized hook-token construction.
//
// The `use workflow` runtime resumes a suspended hook by exact token match.
// Hooks are CREATED inside the workflow and RESUMED from HTTP routes (or from
// the cancel path). Token strings must match exactly across these sites or the
// resume becomes a silent no-op — the workflow stays suspended forever.
//
// This module is the single source of truth for token formats. Any new hook
// must add a helper here; any creator/resumer must call into this module.
// ---------------------------------------------------------------------------

/** Stage failure hook — created per (run, stage). */
export function stageFailedToken(runId: string, stageName: string): string {
  return `failed:${runId}:${stageName}`;
}

/** Stage / consolidation review decision hook — created per review. */
export function reviewToken(reviewId: string): string {
  return `review:${reviewId}`;
}

/** Proposal review hook — created per run (one split per run). */
export function proposalsToken(runId: string): string {
  return `proposals:${runId}`;
}

/** Parallel completion (mixed children) hook — created per run. */
export function parallelToken(runId: string): string {
  return `parallel:${runId}`;
}

/** Finalize-time merge conflict hook — created per run. */
export function finalizeConflictToken(runId: string): string {
  return `conflict:${runId}:finalize`;
}

/** Consolidation merge conflict hook — created per (run, parallelGroup). */
export function consolidateConflictToken(runId: string, groupId: string): string {
  return `conflict:${runId}:${groupId}:consolidate`;
}
