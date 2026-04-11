import { useEffect, useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import { useStreamingStore } from "../../stores/streaming";
import { useWorkspaceStore } from "../../stores/workspace";
import { StageTimeline } from "./StageTimeline";
import { RunConversation } from "./RunConversation";
import { InterventionInput } from "./InterventionInput";
import { StatusBadge } from "../shared/StatusBadge";
import { PopOutButton } from "../shared/PopOutButton";
import { ReviewPanel } from "../review/ReviewPanel";
import type { WebSocketManager } from "../../api/ws";
import type {
  WorkflowRunDetailResponse,
} from "@vibe-harness/shared";

interface RunDetailProps {
  runId: string;
  ws: WebSocketManager | null;
}

const RUNNING_STATUSES = new Set([
  "running",
  "provisioning",
  "finalizing",
  "waiting_for_children",
]);

type TabId = "conversation" | "details" | "review";

export function RunDetail({ runId, ws }: RunDetailProps) {
  const { client } = useDaemonStore();
  const { subscribe, unsubscribe } = useStreamingStore();

  const [detail, setDetail] = useState<WorkflowRunDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("conversation");
  const [cancelling, setCancelling] = useState(false);

  // Fetch run detail
  useEffect(() => {
    if (!client) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getRun(runId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load run");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, runId]);

  // Subscribe to streaming output
  useEffect(() => {
    if (!ws) return;
    subscribe(runId, ws);
    return () => {
      unsubscribe(runId, ws);
    };
  }, [runId, ws, subscribe, unsubscribe]);

  // Re-fetch detail when workspace store status changes (via WS bridge)
  const wsRunStatus = useWorkspaceStore(
    (s) => s.runs.find((r) => r.id === runId)?.status,
  );

  useEffect(() => {
    if (!client || !wsRunStatus || !detail) return;
    if (wsRunStatus === detail.status) return;

    client
      .getRun(runId)
      .then((res) => {
        setDetail(res);
        // Auto-switch to review tab when run enters awaiting_review
        if (res.status === "awaiting_review" && res.activeReviewId) {
          setActiveTab("review");
        }
      })
      .catch((err) => console.error("Failed to refresh run detail:", err));
  }, [client, runId, wsRunStatus, detail?.status]);
  const isRunning = detail ? RUNNING_STATUSES.has(detail.status) : false;

  const handleCancel = useCallback(async () => {
    if (!client || cancelling) return;
    setCancelling(true);
    try {
      await client.cancelRun(runId);
    } catch (err) {
      console.error("Failed to cancel run:", err);
    } finally {
      setCancelling(false);
    }
  }, [client, runId, cancelling]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading run details...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (!detail) return null;

  const hasReview = detail.status === "awaiting_review" && detail.activeReviewId;

  const tabs: { id: TabId; label: string }[] = [
    { id: "conversation", label: "Conversation" },
    { id: "details", label: "Details" },
    ...(hasReview ? [{ id: "review" as TabId, label: "📋 Review" }] : []),
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 pb-3 border-b border-zinc-700/50">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-zinc-200 truncate">
              {detail.title || detail.description?.slice(0, 60) || `Run ${detail.id.slice(0, 8)}`}
            </h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
              <span>{detail.projectName}</span>
              {detail.branch && (
                <>
                  <span>·</span>
                  <span className="font-mono">{detail.branch}</span>
                </>
              )}
              <span>·</span>
              <span>{detail.workflowTemplateName}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <PopOutButton
              route={`/run/${runId}`}
              title={detail.title || `Run ${detail.id.slice(0, 8)}`}
            />
            <StatusBadge status={detail.status} size="md" />
            {isRunning && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="px-3 py-1 text-xs rounded-md border border-red-500/30 text-red-400 hover:bg-red-950/50 disabled:opacity-40 transition-colors"
              >
                {cancelling ? "Cancelling..." : "Cancel"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stage timeline */}
      <div className="flex-shrink-0 border-b border-zinc-700/30">
        <StageTimeline
          stages={detail.stages}
          currentStage={detail.currentStage}
        />
      </div>

      {/* Tab bar */}
      <div className="flex-shrink-0 flex items-center gap-1 py-2 border-b border-zinc-700/30">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === tab.id
                ? "bg-zinc-700/50 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "conversation" && (
          <RunConversation runId={runId} isRunning={isRunning} />
        )}

        {activeTab === "details" && (
          <div className="overflow-y-auto h-full p-4 space-y-4">
            <DetailSection title="Run Info">
              <DetailRow label="ID" value={detail.id} mono />
              <DetailRow label="Status" value={detail.status} />
              <DetailRow label="Current Stage" value={detail.currentStage ?? "—"} />
              <DetailRow label="Created" value={formatTime(detail.createdAt)} />
              {detail.completedAt && (
                <DetailRow label="Completed" value={formatTime(detail.completedAt)} />
              )}
            </DetailSection>

            <DetailSection title="Configuration">
              <DetailRow label="Project" value={detail.projectName} />
              <DetailRow label="Template" value={detail.workflowTemplateName} />
              {detail.baseBranch && (
                <DetailRow label="Base Branch" value={detail.baseBranch} mono />
              )}
              {detail.targetBranch && (
                <DetailRow label="Target Branch" value={detail.targetBranch} mono />
              )}
              {detail.sandboxId && (
                <DetailRow label="Sandbox" value={detail.sandboxId} mono />
              )}
            </DetailSection>

            {detail.description && (
              <DetailSection title="Description">
                <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                  {detail.description}
                </p>
              </DetailSection>
            )}

            {detail.stages.length > 0 && (
              <DetailSection title="Stage Executions">
                <div className="space-y-2">
                  {detail.stages.map((stage) => (
                    <div
                      key={stage.id}
                      className="flex items-center justify-between text-sm bg-zinc-800/30 rounded-md px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <StatusBadge status={stage.status} size="sm" />
                        <span className="text-zinc-300">{stage.stageName}</span>
                        {stage.round > 1 && (
                          <span className="text-xs text-zinc-500">
                            Round {stage.round}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {stage.startedAt
                          ? formatTime(stage.startedAt)
                          : "Not started"}
                      </div>
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}
          </div>
        )}

        {activeTab === "review" && hasReview && (
          <ReviewPanel
            reviewId={detail.activeReviewId!}
            runId={runId}
            onBack={() => setActiveTab("conversation")}
          />
        )}
      </div>

      {/* Intervention input (only when running) */}
      {isRunning && (
        <div className="flex-shrink-0">
          <InterventionInput runId={runId} disabled={!isRunning} />
        </div>
      )}
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
        {title}
      </h3>
      <div className="bg-zinc-800/30 rounded-lg p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-zinc-300 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
