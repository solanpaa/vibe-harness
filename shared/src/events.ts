// WebSocket event types from CDD-schema.md §2.3

import type {
  WorkflowRunStatus, StageStatus, StageFailureReason,
  ReviewStatus, ReviewType, ParallelGroupStatus,
} from './enums';

// ─── Agent output events (ACP → daemon → WebSocket) ───────────────────

export interface AgentOutputEvent {
  role: 'assistant' | 'tool' | 'system' | 'user';
  content: string;
  eventType:
    | 'agent_message'
    | 'agent_thought'
    | 'tool_call'
    | 'tool_result'
    | 'session_update'
    | 'result'
    | 'intervention'
    | 'system_prompt';
  metadata?: {
    toolName?: string;
    toolCallId?: string;
    toolArgs?: Record<string, unknown>;
    isStreaming?: boolean;
    usageStats?: { tokens?: number; durationMs?: number; cost?: number; model?: string };
  };
  timestamp: string;
}

// ─── Client → Server messages ─────────────────────────────────────────

export interface SubscribeMessage {
  type: 'subscribe';
  runId: string;
  lastSeq?: number;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  runId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// ─── Server → Client messages ─────────────────────────────────────────

export interface ConnectedMessage {
  type: 'connected';
  serverVersion: string;
}

export interface RunOutputMessage {
  type: 'run_output';
  runId: string;
  seq: number;
  stageName: string;
  round: number;
  data: AgentOutputEvent;
}

export interface RunStatusMessage {
  type: 'run_status';
  runId: string;
  status: WorkflowRunStatus;
  currentStage: string | null;
  title: string | null;
  projectId: string;
}

export interface StageStatusMessage {
  type: 'stage_status';
  runId: string;
  stageName: string;
  round: number;
  status: StageStatus;
  failureReason: StageFailureReason | null;
}

export interface ReviewCreatedMessage {
  type: 'review_created';
  reviewId: string;
  runId: string;
  stageName: string | null;
  round: number;
  reviewType: ReviewType;
}

export interface ReviewStatusMessage {
  type: 'review_status';
  reviewId: string;
  runId: string;
  status: ReviewStatus;
}

export interface ProposalsReadyMessage {
  type: 'proposals_ready';
  runId: string;
  stageName: string;
  proposalCount: number;
}

export interface ConflictDetectedMessage {
  type: 'conflict_detected';
  runId: string;
  conflictType: 'rebase' | 'merge';
  conflictDetails: string;
}

export interface ParallelGroupStatusMessage {
  type: 'parallel_group_status';
  parallelGroupId: string;
  runId: string;
  status: ParallelGroupStatus;
}

export interface NotificationMessage {
  type: 'notification';
  level: 'info' | 'warning' | 'error';
  message: string;
  runId?: string;
}

export interface ResyncRequiredMessage {
  type: 'resync_required';
  runId: string;
  reason: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | ConnectedMessage
  | RunOutputMessage
  | RunStatusMessage
  | StageStatusMessage
  | ReviewCreatedMessage
  | ReviewStatusMessage
  | ProposalsReadyMessage
  | ConflictDetectedMessage
  | ParallelGroupStatusMessage
  | NotificationMessage
  | ResyncRequiredMessage
  | PongMessage;
