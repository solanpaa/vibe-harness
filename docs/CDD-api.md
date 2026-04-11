# Vibe Harness v2 — Component Detailed Design: REST API & WebSocket

## 1. Overview

This document specifies every HTTP endpoint and WebSocket message for the Vibe Harness v2 daemon API. It is the implementable contract between daemon routes and GUI/CLI clients.

**Transport:** HTTP/1.1 over `localhost:<port>` (port discovered via `~/.vibe-harness/daemon.port`)
**Content type:** `application/json` for all request/response bodies
**Auth:** `Authorization: Bearer <token>` on every request (see §13)
**Framework:** Hono (route registration pattern in §14)

> **Authoritative types:** The TypeScript response types defined in this document are the **canonical specification**. The shared types package (`shared/types/api.ts`, as specified in CDD-schema) must be updated to match this document when discrepancies exist. This CDD-api.md is the source of truth for all request/response shapes, error codes, and WebSocket message types.

---

## 2. Error Response Format

All error responses use a consistent envelope:

```typescript
// shared/types/api.ts
interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

type ErrorCode =
  // Generic
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED'
  // Runs
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_RUNNING'
  | 'RUN_NOT_TERMINAL'
  | 'RUN_NOT_FAILED'
  | 'RUN_ALREADY_RUNNING'
  | 'AGENT_CAPABILITY_MISMATCH'
  | 'SANDBOX_PROVISION_FAILED'
  | 'INVALID_BASE_BRANCH'
  // Reviews
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_ALREADY_RESOLVED'
  | 'REVIEW_NOT_PENDING'
  // Proposals
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_LAUNCHED'
  | 'NO_PROPOSALS_SELECTED'
  // Parallel groups
  | 'PARALLEL_GROUP_NOT_FOUND'
  | 'PARALLEL_GROUP_NOT_READY'
  | 'CONSOLIDATION_CONFLICT'
  // Projects
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_GIT_REPO'
  | 'PATH_NOT_FOUND'
  // Workflows
  | 'WORKFLOW_TEMPLATE_NOT_FOUND'
  | 'WORKFLOW_TEMPLATE_IN_USE'
  // Agents
  | 'AGENT_NOT_FOUND'
  | 'AGENT_IN_USE'
  // Credentials
  | 'CREDENTIAL_SET_NOT_FOUND'
  | 'CREDENTIAL_ENTRY_NOT_FOUND'
  // Worktree
  | 'WORKTREE_NOT_AVAILABLE'
  // Conflict resolution
  | 'NO_ACTIVE_CONFLICT'
  // Prerequisites
  | 'PREREQUISITE_FAILED';
```

**HTTP status code mapping:**

| Status | Error codes |
|--------|------------|
| 400 | `VALIDATION_ERROR`, `AGENT_CAPABILITY_MISMATCH`, `INVALID_BASE_BRANCH`, `INVALID_GIT_REPO`, `NO_PROPOSALS_SELECTED` |
| 401 | `UNAUTHORIZED` |
| 404 | `*_NOT_FOUND`, `NO_ACTIVE_CONFLICT`, `PATH_NOT_FOUND`, `WORKTREE_NOT_AVAILABLE` |
| 409 | `CONFLICT`, `RUN_ALREADY_RUNNING`, `RUN_NOT_TERMINAL`, `RUN_NOT_RUNNING`, `RUN_NOT_FAILED`, `REVIEW_ALREADY_RESOLVED`, `REVIEW_NOT_PENDING`, `PROPOSAL_ALREADY_LAUNCHED`, `PARALLEL_GROUP_NOT_READY`, `CONSOLIDATION_CONFLICT`, `WORKFLOW_TEMPLATE_IN_USE`, `AGENT_IN_USE` |
| 500 | `INTERNAL_ERROR`, `SANDBOX_PROVISION_FAILED` |
| 503 | `PREREQUISITE_FAILED` |

---

## 3. Runs

### 3.1 GET /api/runs

**SRD refs:** FR-D2, FR-D3
**Description:** List workflow runs with optional filters.

**Query parameters:**

```typescript
// shared/types/api.ts
import { z } from 'zod';

const ListRunsQuery = z.object({
  status: z.enum([
    'pending', 'provisioning', 'running', 'stage_failed',
    'awaiting_review', 'awaiting_proposals', 'waiting_for_children',
    'children_completed_with_failures', 'awaiting_conflict_resolution',
    'finalizing', 'completed', 'failed', 'cancelled',
  ]).optional(),
  projectId: z.string().uuid().optional(),
  parentRunId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  fields: z.enum(['summary', 'full']).default('full'),
});
type ListRunsQuery = z.infer<typeof ListRunsQuery>;
```

**Response:** `200 OK`

```typescript
interface ListRunsResponse {
  runs: WorkflowRunSummary[];
  total: number;
}

interface WorkflowRunSummary {
  id: string;
  title: string | null;
  description: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  projectId: string;
  projectName: string;
  workflowTemplateName: string;
  branch: string | null;
  parentRunId: string | null;
  createdAt: string;       // ISO 8601
  completedAt: string | null;
  // Omitted when fields=summary:
  stages?: StageExecutionSummary[];
  agentDefinitionId?: string;
  credentialSetId?: string | null;
  baseBranch?: string | null;
  targetBranch?: string | null;
}
```

**Error cases:** None specific (empty array on no results).

---

### 3.2 POST /api/runs

**SRD refs:** FR-W3, FR-W4, FR-W13, FR-W17, FR-W18, FR-W22
**Description:** Create and start a workflow run. The run is created in `pending` status and the workflow pipeline is started asynchronously.

**Request body:**

```typescript
const CreateRunBody = z.object({
  projectId: z.string().uuid(),
  description: z.string().min(1).max(5000),
  workflowTemplateId: z.string().uuid().optional(),   // default: "Quick Run" template
  agentDefinitionId: z.string().uuid().optional(),     // default: Copilot CLI
  credentialSetId: z.string().uuid().nullable().optional(), // null = use project default
  baseBranch: z.string().regex(/^[a-zA-Z0-9._\/-]+$/).optional(), // default: current checked-out branch
  targetBranch: z.string().regex(/^[a-zA-Z0-9._\/-]+$/).optional(), // default: baseBranch
  title: z.string().max(200).optional(),               // if omitted, auto-generated
});
type CreateRunBody = z.infer<typeof CreateRunBody>;
```

**Response:** `201 Created`

```typescript
interface CreateRunResponse {
  id: string;
  status: 'pending';
  title: string | null;
  branch: string | null; // set asynchronously by branch-namer
}
```

**Error cases:**
- `400 VALIDATION_ERROR` — invalid body fields
- `400 AGENT_CAPABILITY_MISMATCH` — agent missing required capabilities for template (e.g., `supportsContinue` for multi-stage)
- `400 INVALID_BASE_BRANCH` — baseBranch is detached HEAD or doesn't exist
- `404 PROJECT_NOT_FOUND` — projectId doesn't exist
- `404 WORKFLOW_TEMPLATE_NOT_FOUND` — workflowTemplateId doesn't exist
- `404 AGENT_NOT_FOUND` — agentDefinitionId doesn't exist
- `404 CREDENTIAL_SET_NOT_FOUND` — credentialSetId doesn't exist

**Side effects:**
1. Creates `workflowRuns` record (status: `pending`)
2. Updates `lastRunConfig` singleton
3. Calls `start(runWorkflowPipeline, [{ runId, ... }])` — fire-and-forget
4. Pipeline asynchronously: provisions sandbox, creates worktree, generates branch name, starts first stage

---

### 3.3 GET /api/runs/:id

**SRD refs:** FR-W16
**Description:** Get full run details including stages, current state, and timing.

**Response:** `200 OK`

```typescript
interface GetRunResponse {
  id: string;
  title: string | null;
  description: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  projectId: string;
  projectName: string;
  workflowTemplateId: string;
  workflowTemplateName: string;
  agentDefinitionId: string;
  parentRunId: string | null;
  parallelGroupId: string | null;
  sandboxId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  credentialSetId: string | null;
  createdAt: string;
  completedAt: string | null;
  stages: StageExecutionDetail[];
  activeReviewId: string | null;    // current pending review, if any
  childRunIds: string[];            // for parent runs with split children
}

interface StageExecutionDetail {
  id: string;
  stageName: string;
  round: number;
  status: StageStatus;
  freshSession: boolean;
  prompt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  usageStats: UsageStats | null;
  reviewId: string | null;          // review created for this stage+round
}

interface UsageStats {
  tokens?: number;
  duration?: number;   // ms
  cost?: number;
  model?: string;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`

---

### 3.4 DELETE /api/runs/:id

**SRD refs:** —
**Description:** Delete a workflow run. Only runs in terminal states can be deleted.

**Response:** `204 No Content`

**Error cases:**
- `404 RUN_NOT_FOUND`
- `409 RUN_NOT_TERMINAL` — run is not in `completed`, `failed`, or `cancelled` state

**Side effects:**
1. Cascade-deletes `stageExecutions`, `runMessages`, `reviews`, `reviewComments`, `proposals`
2. If worktree still exists, schedules cleanup

---

### 3.5 PATCH /api/runs/:id/cancel

**SRD refs:** FR-W10
**Description:** Cancel a running workflow. Sends ACP stop to agent; force-kills sandbox after 30s timeout.

**Request body:** None (empty or `{}`)

**Response:** `200 OK`

```typescript
interface CancelRunResponse {
  id: string;
  status: 'cancelled';
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `409 RUN_NOT_RUNNING` — run is already in a terminal or non-cancellable state

**Side effects:**
1. Sends ACP stop command to agent (graceful)
2. After 30s timeout, force-kills sandbox process
3. If run has active split children, cascades cancellation to all running children
4. Marks `workflowRun.status = 'cancelled'`
5. Worktree state preserved as-is (no final diff snapshot)
6. Pushes `run_status` event to WebSocket subscribers

---

### 3.6 POST /api/runs/:id/message

**SRD refs:** FR-W21
**Description:** Send a mid-execution intervention message to the running agent via ACP stdin.

**Request body:**

```typescript
const SendMessageBody = z.object({
  content: z.string().min(1).max(50000),
});
type SendMessageBody = z.infer<typeof SendMessageBody>;
```

**Response:** `200 OK`

```typescript
interface SendMessageResponse {
  messageId: string;
  deliveredAt: string;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `409 RUN_NOT_RUNNING` — no active stage execution

**Side effects:**
1. Serialized through session-manager mutex (`withSession`)
2. Sends message via ACP stdin into current conversation
3. Creates `runMessages` record with `isIntervention=true`
4. Pushes `run_output` event (role: `user`, isIntervention: true) to WebSocket

---

### 3.7 GET /api/runs/:id/diff

**SRD refs:** FR-R2
**Description:** Get the current live diff for a run's worktree (merge-base to working tree).

**Response:** `200 OK`

```typescript
interface GetDiffResponse {
  diff: string;         // unified diff text
  files: DiffFile[];
  stats: DiffStats;
}

interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;        // for renames
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
}

interface DiffChunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `404 WORKTREE_NOT_AVAILABLE` — no worktree available (run is pending, already cleaned up, or never provisioned)

---

### 3.8 GET /api/runs/:id/messages

**SRD refs:** FR-W16, FR-W19
**Description:** Get the complete conversation history for a run. Supports pagination for large conversations.

**Query parameters:**

```typescript
const GetMessagesQuery = z.object({
  stageName: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  after: z.string().datetime().optional(),  // cursor: return messages after this timestamp
});
type GetMessagesQuery = z.infer<typeof GetMessagesQuery>;
```

**Response:** `200 OK`

```typescript
interface GetMessagesResponse {
  messages: RunMessage[];
  total: number;
  hasMore: boolean;
}

interface RunMessage {
  id: string;
  stageName: string;
  round: number;
  sessionBoundary: boolean;  // marks freshSession reset
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  isIntervention: boolean;
  metadata: MessageMetadata | null;
  createdAt: string;
}

interface MessageMetadata {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  thought?: string;
  usageStats?: UsageStats;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`

---

### 3.9 POST /api/runs/:id/retry-stage

**SRD refs:** FR-W14
**Description:** Retry a failed stage. Sends a failure-aware message into the conversation and re-executes.

**Request body:** None (empty or `{}`)

**Response:** `200 OK`

```typescript
interface RetryStageResponse {
  id: string;
  status: 'running';
  currentStage: string;
  round: number;  // incremented
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `409 RUN_NOT_FAILED` — run is not in `stage_failed` state

**Side effects:**
1. Writes `hookResumes` outbox entry
2. Resumes `stageFailedHook` with `{ action: 'retry' }`
3. Workflow sends failure-aware prompt: `"The previous attempt failed with: {error}. Please retry: {stage prompt}"`
4. New `stageExecution` created with incremented round
5. Pushes `run_status` and `stage_status` events to WebSocket

---

### 3.10 POST /api/runs/:id/skip-stage

**SRD refs:** FR-W14
**Description:** Skip a failed stage and advance to the next one.

**Request body:** None (empty or `{}`)

**Response:** `200 OK`

```typescript
interface SkipStageResponse {
  id: string;
  status: WorkflowRunStatus; // 'running' for next stage or terminal
  currentStage: string | null;
  skippedStage: string;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `409 RUN_NOT_FAILED` — run is not in `stage_failed` state

**Side effects:**
1. Writes `hookResumes` outbox entry
2. Resumes `stageFailedHook` with `{ action: 'skip' }`
3. Previous stage marked `skipped` (previousResult = null)
4. Workflow advances to next stage

---

### 3.11 POST /api/runs/:id/resolve-conflict

**SRD refs:** FR-R10, FR-S10
**Description:** Resume after the user has externally resolved a git conflict (rebase or merge).

**Request body:**

```typescript
const ResolveConflictBody = z.object({
  action: z.enum(['retry', 'cancel']),
});
type ResolveConflictBody = z.infer<typeof ResolveConflictBody>;
```

**Response:** `200 OK`

```typescript
interface ResolveConflictResponse {
  id: string;
  status: WorkflowRunStatus;
}
```

**Error cases:**
- `404 RUN_NOT_FOUND`
- `404 NO_ACTIVE_CONFLICT` — run is not in `awaiting_conflict_resolution` state

**Side effects:**
1. Writes `hookResumes` outbox entry
2. Resumes `conflictHook` with the action
3. `retry`: re-attempts rebase/merge (user should have resolved conflicts externally)
4. `cancel`: workflow fails with `merge_conflict` reason

---

## 4. Workflow Templates

### 4.1 GET /api/workflows

**SRD refs:** FR-W1, FR-W11, FR-W12
**Description:** List all workflow templates.

**Response:** `200 OK`

```typescript
interface ListWorkflowsResponse {
  workflows: WorkflowTemplate[];
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  stages: WorkflowStage[];
  isBuiltIn: boolean;     // true for system templates (Quick Run, Plan & Implement, Full Review)
  createdAt: string;
  updatedAt: string;
}

interface WorkflowStage {
  name: string;
  type: 'standard' | 'split';
  promptTemplate: string;
  reviewRequired: boolean;    // mutually exclusive with autoAdvance
  autoAdvance: boolean;
  freshSession: boolean;
  isFinal?: boolean;          // explicit final stage marker
}
```

**Error cases:** None specific.

---

### 4.2 POST /api/workflows

**SRD refs:** FR-W1, FR-W2
**Description:** Create a new workflow template.

**Request body:**

```typescript
const CreateWorkflowBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  stages: z.array(z.object({
    name: z.string().min(1).max(50),
    type: z.enum(['standard', 'split']),
    promptTemplate: z.string().min(1).max(10000),
    reviewRequired: z.boolean().default(true),
    autoAdvance: z.boolean().default(false),
    freshSession: z.boolean().default(false),
    isFinal: z.boolean().optional(),
  })).min(1).max(20)
    .refine(stages => stages.every(s => !(s.reviewRequired && s.autoAdvance)),
      { message: 'reviewRequired and autoAdvance are mutually exclusive' }),
});
type CreateWorkflowBody = z.infer<typeof CreateWorkflowBody>;
```

**Response:** `201 Created`

```typescript
interface CreateWorkflowResponse {
  id: string;
  name: string;
  description: string | null;
  stages: WorkflowStage[];
  isBuiltIn: false;           // user-created templates are never built-in
  createdAt: string;
}
```

**Error cases:**
- `400 VALIDATION_ERROR` — invalid body, mutually exclusive flags, etc.

**Side effects:**
1. Creates `workflowTemplates` record with stages serialized as JSON

---

### 4.3 GET /api/workflows/:id

**SRD refs:** FR-W12
**Description:** Get a workflow template by ID.

**Response:** `200 OK` — `WorkflowTemplate` object

**Error cases:**
- `404 WORKFLOW_TEMPLATE_NOT_FOUND`

---

### 4.4 PUT /api/workflows/:id

**SRD refs:** FR-W12
**Description:** Replace a workflow template (full update). Built-in templates cannot be modified.

**Request body:** Same as `CreateWorkflowBody`

**Response:** `200 OK` — updated `WorkflowTemplate`

**Error cases:**
- `404 WORKFLOW_TEMPLATE_NOT_FOUND`
- `409 CONFLICT` — attempting to modify a built-in template

---

### 4.5 DELETE /api/workflows/:id

**SRD refs:** FR-W12
**Description:** Delete a workflow template. Cannot delete built-in templates or templates with active (non-terminal) runs.

**Response:** `204 No Content`

**Error cases:**
- `404 WORKFLOW_TEMPLATE_NOT_FOUND`
- `409 CONFLICT` — built-in template
- `409 WORKFLOW_TEMPLATE_IN_USE` — active runs reference this template

---

## 5. Reviews

### 5.1 GET /api/reviews

**SRD refs:** FR-R1, FR-R9
**Description:** List reviews, optionally filtered by run and/or stage. Supports round navigation.

**Query parameters:**

```typescript
const ListReviewsQuery = z.object({
  runId: z.string().uuid().optional(),
  stageName: z.string().optional(),
  type: z.enum(['stage', 'consolidation']).optional(),
  status: z.enum(['pending_review', 'approved', 'changes_requested']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListReviewsQuery = z.infer<typeof ListReviewsQuery>;
```

**Response:** `200 OK`

```typescript
interface ListReviewsResponse {
  reviews: ReviewSummary[];
  total: number;
}

interface ReviewSummary {
  id: string;
  workflowRunId: string;
  stageName: string | null;
  round: number;
  type: 'stage' | 'consolidation';
  status: ReviewStatus;
  aiSummary: string | null;
  commentCount: number;
  createdAt: string;
}
```

**Error cases:** None specific.

---

### 5.2 GET /api/reviews/:id

**SRD refs:** FR-R2, FR-R3, FR-R11
**Description:** Get a review with full diff snapshot, AI summary, and plan markdown.

**Response:** `200 OK`

```typescript
interface GetReviewResponse {
  id: string;
  workflowRunId: string;
  stageName: string | null;
  round: number;
  type: 'stage' | 'consolidation';
  status: ReviewStatus;
  aiSummary: string | null;
  planMarkdown: string | null;
  diff: DiffFile[];
  diffStats: DiffStats;
  rawDiff: string;            // full unified diff text
  comments: ReviewComment[];
  createdAt: string;
}

interface ReviewComment {
  id: string;
  reviewId: string;
  filePath: string | null;   // null = general comment
  lineNumber: number | null;
  side: 'left' | 'right' | null;
  body: string;
  createdAt: string;
}
```

**Error cases:**
- `404 REVIEW_NOT_FOUND`

---

### 5.3 POST /api/reviews/:id/approve

**SRD refs:** FR-R6, FR-R10, NFR-R5
**Description:** Approve a review, advancing the workflow to the next stage. Idempotent — re-approving an already-approved review is a no-op.

**Request body:** None (empty or `{}`)

**Response:** `200 OK`

```typescript
interface ApproveReviewResponse {
  id: string;
  status: 'approved';
  workflowRunId: string;
  nextStage: string | null; // null if this was the last stage
}
```

**Error cases:**
- `404 REVIEW_NOT_FOUND`
- `409 REVIEW_NOT_PENDING` — review status is `changes_requested` (must create new round first)

**Side effects (non-idempotent path):**
1. Writes `hookResumes` outbox entry
2. Updates `reviews.status = 'approved'`
3. Calls `resumeHook(token, { action: 'approve' })` — resumes suspended workflow
4. Deletes `hookResumes` entry on success
5. If last stage: triggers finalize step (commit → rebase → merge → cleanup)
6. If consolidation review: fast-forwards parent worktree to consolidation branch
7. Pushes `run_status` event to WebSocket

---

### 5.4 POST /api/reviews/:id/request-changes

**SRD refs:** FR-R7, FR-R8
**Description:** Request changes on a review. Comments are bundled as markdown and injected into the agent conversation. Agent re-executes in the same session.

**Request body:**

```typescript
const RequestChangesBody = z.object({
  comments: z.array(z.object({
    filePath: z.string().nullable().optional(),
    lineNumber: z.number().int().positive().nullable().optional(),
    side: z.enum(['left', 'right']).nullable().optional(),
    body: z.string().min(1).max(5000),
  })).min(1, 'At least one comment is required'),
});
type RequestChangesBody = z.infer<typeof RequestChangesBody>;
```

**Response:** `200 OK`

```typescript
interface RequestChangesResponse {
  id: string;
  status: 'changes_requested';
  workflowRunId: string;
  nextRound: number;
}
```

**Error cases:**
- `404 REVIEW_NOT_FOUND`
- `409 REVIEW_NOT_PENDING` — review already approved or changes already requested

**Side effects:**
1. Persists all comments as `reviewComments` records
2. Updates `reviews.status = 'changes_requested'`
3. Writes `hookResumes` outbox entry
4. Resumes `reviewDecisionHook` with `{ action: 'request_changes', comments }`
5. Workflow `inject-comments` step bundles comments as markdown user message
6. Sends bundled message into existing ACP conversation via `sessionManager.continue()`
7. Agent continues execution in same session; new `stageExecution` with incremented round
8. Pushes `run_status` and `stage_status` events to WebSocket

---

### 5.5 POST /api/reviews/:id/comments

**SRD refs:** FR-R4, FR-R5
**Description:** Add a comment to a review (inline or general). Can be used to build up comments before submitting request-changes, or for annotation purposes.

**Request body:**

```typescript
const AddCommentBody = z.object({
  filePath: z.string().nullable().optional(),
  lineNumber: z.number().int().positive().nullable().optional(),
  side: z.enum(['left', 'right']).nullable().optional(),
  body: z.string().min(1).max(5000),
});
type AddCommentBody = z.infer<typeof AddCommentBody>;
```

**Response:** `201 Created`

```typescript
interface AddCommentResponse {
  id: string;
  reviewId: string;
  createdAt: string;
}
```

**Error cases:**
- `404 REVIEW_NOT_FOUND`
- `400 VALIDATION_ERROR` — `lineNumber` provided without `filePath`

---

### 5.6 GET /api/reviews/:id/comments

**SRD refs:** FR-R4, FR-R5
**Description:** Get all comments for a review.

**Response:** `200 OK`

```typescript
interface ListCommentsResponse {
  comments: ReviewComment[];
}
```

**Error cases:**
- `404 REVIEW_NOT_FOUND`

---

## 6. Proposals

### 6.1 GET /api/proposals

**SRD refs:** FR-S1, FR-S3
**Description:** List proposals for a workflow run's split stage.

**Query parameters:**

```typescript
const ListProposalsQuery = z.object({
  runId: z.string().uuid(),
  stageName: z.string().optional(),
});
type ListProposalsQuery = z.infer<typeof ListProposalsQuery>;
```

**Response:** `200 OK`

```typescript
interface ListProposalsResponse {
  proposals: Proposal[];
}

interface Proposal {
  id: string;
  workflowRunId: string;
  stageName: string;
  parallelGroupId: string | null;
  title: string;
  description: string;
  affectedFiles: string[];
  dependsOn: string[];         // proposal IDs — metadata only, not enforced
  workflowTemplateOverride: string | null;
  status: ProposalStatus;
  launchedWorkflowRunId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

**Error cases:**
- `400 VALIDATION_ERROR` — missing `runId`

---

### 6.2 POST /api/proposals

**SRD refs:** FR-S3
**Description:** Manually add a proposal to a workflow run's split stage. Used when the user wants to add sub-tasks beyond what the agent generated.

**Request body:**

```typescript
const CreateProposalBody = z.object({
  workflowRunId: z.string().uuid(),
  stageName: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  affectedFiles: z.array(z.string()).optional().default([]),
  dependsOn: z.array(z.string().uuid()).optional().default([]),
  workflowTemplateOverride: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
type CreateProposalBody = z.infer<typeof CreateProposalBody>;
```

**Response:** `201 Created`

```typescript
interface CreateProposalResponse {
  id: string;
  workflowRunId: string;
  stageName: string;
  title: string;
  status: 'proposed';
  sortOrder: number;
  createdAt: string;
}
```

**Error cases:**
- `400 VALIDATION_ERROR` — invalid body fields
- `404 RUN_NOT_FOUND` — workflowRunId doesn't exist
- `409 CONFLICT` — run is not in `awaiting_proposals` state (proposals can only be added while the proposal gate is active)

**Side effects:**
1. Creates `proposals` record with status `proposed`
2. If `sortOrder` not provided, appends after the last existing proposal

---

### 6.3 GET /api/proposals/:id

**SRD refs:** FR-S3
**Description:** Get a single proposal.

**Response:** `200 OK` — `Proposal` object

**Error cases:**
- `404 PROPOSAL_NOT_FOUND`

---

### 6.4 PUT /api/proposals/:id

**SRD refs:** FR-S3
**Description:** Edit a proposal before launch. Only editable in `proposed` status.

**Request body:**

```typescript
const UpdateProposalBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(10000).optional(),
  affectedFiles: z.array(z.string()).optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
  workflowTemplateOverride: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
type UpdateProposalBody = z.infer<typeof UpdateProposalBody>;
```

**Response:** `200 OK` — updated `Proposal`

**Error cases:**
- `404 PROPOSAL_NOT_FOUND`
- `409 PROPOSAL_ALREADY_LAUNCHED` — proposal is not in `proposed` status

---

### 6.5 DELETE /api/proposals/:id

**SRD refs:** FR-S3
**Description:** Discard a proposal (set status to `discarded`). Only in `proposed` status.

**Response:** `204 No Content`

**Error cases:**
- `404 PROPOSAL_NOT_FOUND`
- `409 PROPOSAL_ALREADY_LAUNCHED`

**Side effects:**
1. Sets `proposals.status = 'discarded'`

---

### 6.6 POST /api/proposals/launch

**SRD refs:** FR-S4, FR-S5, FR-S6
**Description:** Launch selected proposals as parallel child workflow runs.

**Request body:**

```typescript
const LaunchProposalsBody = z.object({
  proposalIds: z.array(z.string().uuid()).min(1),
});
type LaunchProposalsBody = z.infer<typeof LaunchProposalsBody>;
```

**Response:** `200 OK`

```typescript
interface LaunchProposalsResponse {
  parallelGroupId: string;
  childRuns: Array<{
    proposalId: string;
    runId: string;
    branch: string | null;
  }>;
}
```

**Error cases:**
- `400 NO_PROPOSALS_SELECTED` — empty proposalIds array
- `404 PROPOSAL_NOT_FOUND` — any proposalId doesn't exist
- `409 PROPOSAL_ALREADY_LAUNCHED` — any proposal already launched

**Side effects:**
1. Writes `hookResumes` outbox entry
2. Resumes `proposalReviewHook` with `{ proposalIds }`
3. Workflow creates `parallelGroup` record
4. For each proposal: creates child `workflowRun`, provisions sandbox + worktree (branched off parent's worktree HEAD)
5. Marks proposals as `launched` with `launchedWorkflowRunId`
6. Parent run transitions to `waiting_for_children`
7. Pushes `run_status` events to WebSocket for parent and each child

---

## 7. Parallel Groups

### 7.1 GET /api/parallel-groups/:id

**SRD refs:** FR-S7
**Description:** Get parallel group status including per-child summary.

**Response:** `200 OK`

```typescript
interface GetParallelGroupResponse {
  id: string;
  sourceWorkflowRunId: string;
  name: string | null;
  description: string | null;
  status: ParallelGroupStatus;
  children: ParallelGroupChild[];
  createdAt: string;
  completedAt: string | null;
}

interface ParallelGroupChild {
  runId: string;
  proposalId: string;
  title: string;
  status: WorkflowRunStatus;
  branch: string | null;
}
```

**Error cases:**
- `404 PARALLEL_GROUP_NOT_FOUND`

---

### 7.2 POST /api/parallel-groups/:id/consolidate

**SRD refs:** FR-S8, FR-S9
**Description:** Start consolidation of all completed children. Only available when all children are in terminal states and at least one succeeded.

**Request body:** None

**Response:** `200 OK`

```typescript
interface ConsolidateResponse {
  parallelGroupId: string;
  status: 'consolidating';
  childrenIncluded: string[];   // runIds being merged
}
```

**Error cases:**
- `404 PARALLEL_GROUP_NOT_FOUND`
- `409 PARALLEL_GROUP_NOT_READY` — not all children in terminal state
- `409 CONSOLIDATION_CONFLICT` — a merge conflict occurred (returned after attempt)

**Side effects:**
1. Creates consolidation branch from parent worktree HEAD
2. Merges completed child branches sequentially (in `proposals.sortOrder`)
3. On success: creates consolidation review (type: `consolidation`)
4. On conflict: aborts merge, returns `409 CONSOLIDATION_CONFLICT` with conflicting child info
5. Updates `parallelGroup.status`

---

### 7.3 POST /api/parallel-groups/:id/consolidate-partial

**SRD refs:** FR-S8, FR-S12
**Description:** Consolidate only completed children, skipping failed/cancelled ones. Used when some children failed and user wants to proceed with what succeeded.

**Request body:**

```typescript
const ConsolidatePartialBody = z.object({
  excludeRunIds: z.array(z.string().uuid()).optional(), // explicitly exclude specific children
});
type ConsolidatePartialBody = z.infer<typeof ConsolidatePartialBody>;
```

**Response:** `200 OK` — same as `ConsolidateResponse`

**Error cases:**
- `404 PARALLEL_GROUP_NOT_FOUND`
- `409 PARALLEL_GROUP_NOT_READY` — children still running
- `400 VALIDATION_ERROR` — no completed children remain after exclusions

**Side effects:** Same as consolidate, but only includes children with `completed` status (minus explicitly excluded).

---

### 7.4 POST /api/parallel-groups/:id/retry-children

**SRD refs:** FR-S12
**Description:** Retry failed child workflow runs.

**Request body:**

```typescript
const RetryChildrenBody = z.object({
  childRunIds: z.array(z.string().uuid()).min(1),
});
type RetryChildrenBody = z.infer<typeof RetryChildrenBody>;
```

**Response:** `200 OK`

```typescript
interface RetryChildrenResponse {
  retriedRuns: Array<{
    originalRunId: string;
    newRunId: string;
  }>;
}
```

**Error cases:**
- `404 PARALLEL_GROUP_NOT_FOUND`
- `404 RUN_NOT_FOUND` — any childRunId doesn't exist or doesn't belong to this group
- `409 RUN_NOT_TERMINAL` — any child run is still running

**Side effects:**
1. For each child: creates new workflow run with same proposal, new sandbox + worktree
2. Links new runs to same parallel group
3. Parent re-enters `waiting_for_children` state
4. Pushes `run_status` events

---

### 7.5 POST /api/parallel-groups/:id/cancel

**SRD refs:** FR-S7
**Description:** Cancel the parallel group and all running children.

**Request body:** None

**Response:** `200 OK`

```typescript
interface CancelGroupResponse {
  parallelGroupId: string;
  status: 'cancelled';
  cancelledChildren: string[];
}
```

**Error cases:**
- `404 PARALLEL_GROUP_NOT_FOUND`

**Side effects:**
1. Writes `hookResumes` outbox entry
2. Sends ACP stop to all running children (cascaded cancellation)
3. Resumes `parallelCompletionHook` with `{ action: 'cancel' }`
4. Parent workflow transitions to `cancelled`

---

## 8. Projects

### 8.1 GET /api/projects

**SRD refs:** FR-P2
**Description:** List all registered projects.

**Response:** `200 OK`

```typescript
interface ListProjectsResponse {
  projects: Project[];
}

interface Project {
  id: string;
  name: string;
  gitUrl: string | null;
  localPath: string;
  description: string | null;
  defaultCredentialSetId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

---

### 8.2 POST /api/projects

**SRD refs:** FR-P1, FR-P7
**Description:** Register a local git repository as a project. The `gitUrl` field is auto-extracted from `git remote get-url origin` and is not accepted in the request body.

**Request body:**

```typescript
const CreateProjectBody = z.object({
  name: z.string().min(1).max(100),
  localPath: z.string().min(1),
  description: z.string().max(500).nullable().optional(),
  defaultCredentialSetId: z.string().uuid().nullable().optional(),
});
type CreateProjectBody = z.infer<typeof CreateProjectBody>;
```

**Response:** `201 Created`

```typescript
interface CreateProjectResponse {
  id: string;
  name: string;
  localPath: string;
  gitUrl: string | null;  // extracted from git remote
  createdAt: string;
}
```

**Error cases:**
- `400 VALIDATION_ERROR`
- `400 INVALID_GIT_REPO` — path is not a valid git repository
- `404 PATH_NOT_FOUND` — localPath doesn't exist on filesystem

**Side effects:**
1. Validates path exists and is a git repository (`git -C <path> rev-parse --git-dir`)
2. Extracts `gitUrl` from `git remote get-url origin` (nullable if no remote)
3. Creates `projects` record

---

### 8.3 GET /api/projects/:id

**SRD refs:** FR-P1
**Description:** Get project details.

**Response:** `200 OK` — `Project` object

**Error cases:**
- `404 PROJECT_NOT_FOUND`

---

### 8.4 PATCH /api/projects/:id

**SRD refs:** FR-P4, FR-P6
**Description:** Update project metadata.

**Request body:**

```typescript
const UpdateProjectBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  defaultCredentialSetId: z.string().uuid().nullable().optional(),
});
type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;
```

**Response:** `200 OK` — updated `Project`

**Error cases:**
- `404 PROJECT_NOT_FOUND`
- `404 CREDENTIAL_SET_NOT_FOUND` — defaultCredentialSetId doesn't exist

---

### 8.5 DELETE /api/projects/:id

**SRD refs:** FR-P3
**Description:** Remove a registered project. Does not delete the git repository.

**Response:** `204 No Content`

**Error cases:**
- `404 PROJECT_NOT_FOUND`
- `409 CONFLICT` — active (non-terminal) workflow runs reference this project

---

### 8.6 GET /api/projects/:id/branches

**SRD refs:** FR-P5
**Description:** List git branches for a project.

**Response:** `200 OK`

```typescript
interface ListBranchesResponse {
  branches: Branch[];
  currentBranch: string | null; // null if detached HEAD
}

interface Branch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit: string | null; // short SHA
}
```

**Error cases:**
- `404 PROJECT_NOT_FOUND`

---

## 9. Agents

### 9.1 GET /api/agents

**SRD refs:** FR-A2
**Description:** List all agent definitions.

**Response:** `200 OK`

```typescript
interface ListAgentsResponse {
  agents: AgentDefinition[];
}

interface AgentDefinition {
  id: string;
  name: string;
  type: 'copilot_cli';  // MVP: only copilot_cli
  commandTemplate: string;
  dockerImage: string | null;
  description: string | null;
  supportsStreaming: boolean;
  supportsContinue: boolean;
  supportsIntervention: boolean;
  outputFormat: 'acp' | 'jsonl' | 'text';
  isBuiltIn: boolean;
  createdAt: string;
}
```

---

### 9.2 GET /api/agents/:id

**SRD refs:** FR-A2
**Description:** Get a single agent definition by ID.

**Response:** `200 OK` — `AgentDefinition` object

**Error cases:**
- `404 AGENT_NOT_FOUND`

---

### 9.3 POST /api/agents

**SRD refs:** FR-A1
**Description:** Create a new agent definition.

**Request body:**

```typescript
const CreateAgentBody = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['copilot_cli']),
  commandTemplate: z.string().min(1).max(1000),
  dockerImage: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  supportsStreaming: z.boolean().default(true),
  supportsContinue: z.boolean().default(true),
  supportsIntervention: z.boolean().default(true),
  outputFormat: z.enum(['acp', 'jsonl', 'text']).default('acp'),
});
type CreateAgentBody = z.infer<typeof CreateAgentBody>;
```

**Response:** `201 Created` — `AgentDefinition` object (with `isBuiltIn: false`)

**Error cases:**
- `400 VALIDATION_ERROR`

---

### 9.4 PUT /api/agents/:id

**SRD refs:** FR-A2
**Description:** Update an agent definition. Built-in definitions cannot be modified.

**Request body:** Same as `CreateAgentBody`

**Response:** `200 OK` — updated `AgentDefinition`

**Error cases:**
- `404 AGENT_NOT_FOUND`
- `409 CONFLICT` — built-in agent definition

---

### 9.5 DELETE /api/agents/:id

**SRD refs:** FR-A2
**Description:** Delete an agent definition.

**Response:** `204 No Content`

**Error cases:**
- `404 AGENT_NOT_FOUND`
- `409 CONFLICT` — built-in agent definition
- `409 AGENT_IN_USE` — active runs reference this agent

---

## 10. Credentials

### 10.1 GET /api/credentials

**SRD refs:** FR-C1, FR-C6
**Description:** List credential sets. Optionally filter by project scope.

**Query parameters:**

```typescript
const ListCredentialsQuery = z.object({
  projectId: z.string().uuid().optional(), // filter to project-scoped + global sets
});
type ListCredentialsQuery = z.infer<typeof ListCredentialsQuery>;
```

**Response:** `200 OK`

```typescript
interface ListCredentialSetsResponse {
  credentialSets: CredentialSet[];
}

interface CredentialSet {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;  // null = global
  entryCount: number;
  createdAt: string;
}
```

---

### 10.2 POST /api/credentials

**SRD refs:** FR-C1
**Description:** Create a new credential set.

**Request body:**

```typescript
const CreateCredentialSetBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), // null = global
});
type CreateCredentialSetBody = z.infer<typeof CreateCredentialSetBody>;
```

**Response:** `201 Created`

```typescript
interface CreateCredentialSetResponse {
  id: string;
  name: string;
  createdAt: string;
}
```

**Error cases:**
- `400 VALIDATION_ERROR`
- `404 PROJECT_NOT_FOUND` — projectId doesn't exist

**Side effects:**
1. Creates `credentialSets` record
2. Writes `credentialAuditLog` entry (action: `create_set`)

---

### 10.3 GET /api/credentials/:id

**SRD refs:** FR-C1, FR-C7
**Description:** Get a credential set with its entries (values masked).

**Response:** `200 OK`

```typescript
interface GetCredentialSetResponse {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  entries: CredentialEntry[];
  createdAt: string;
}

interface CredentialEntry {
  id: string;
  key: string;
  value: '***';           // ALWAYS masked — FR-C7
  type: CredentialEntryType;
  mountPath: string | null;
  command: string | null;
  createdAt: string;
}

type CredentialEntryType =
  | 'env_var'
  | 'file_mount'
  | 'docker_login'
  | 'host_dir_mount'
  | 'command_extract';
```

---

### 10.4 PATCH /api/credentials/:id

**SRD refs:** FR-C1
**Description:** Update a credential set's name or description.

**Request body:**

```typescript
const UpdateCredentialSetBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});
type UpdateCredentialSetBody = z.infer<typeof UpdateCredentialSetBody>;
```

**Response:** `200 OK`

```typescript
interface UpdateCredentialSetResponse {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  entryCount: number;
  createdAt: string;
}
```

**Error cases:**
- `404 CREDENTIAL_SET_NOT_FOUND`
- `400 VALIDATION_ERROR`

---

### 10.5 DELETE /api/credentials/:id

**SRD refs:** FR-C1
**Description:** Delete a credential set and all its entries.

**Response:** `204 No Content`

**Error cases:**
- `404 CREDENTIAL_SET_NOT_FOUND`

**Side effects:**
1. Cascade-deletes all `credentialEntries`
2. Nullifies `projects.defaultCredentialSetId` and `workflowRuns.credentialSetId` references
3. Writes `credentialAuditLog` entry (action: `delete_set`)

---

### 10.6 POST /api/credentials/:id/entries

**SRD refs:** FR-C2, FR-C3
**Description:** Add an entry to a credential set. Value is encrypted at rest.

**Request body:**

```typescript
const CreateCredentialEntryBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('env_var'),
    key: z.string().min(1).max(200),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal('file_mount'),
    key: z.string().min(1).max(200),
    value: z.string().min(1),          // file content
    mountPath: z.string().min(1),      // target path in sandbox
  }),
  z.object({
    type: z.literal('docker_login'),
    key: z.string().min(1).max(200),   // registry URL
    value: z.string().min(1),          // JSON: { username, password }
  }),
  z.object({
    type: z.literal('host_dir_mount'),
    key: z.string().min(1).max(200),
    value: z.string().min(1),          // host directory path
    mountPath: z.string().min(1),      // target path in sandbox
  }),
  z.object({
    type: z.literal('command_extract'),
    key: z.string().min(1).max(200),   // env var name to store result
    command: z.string().min(1),        // shell command to run on host
  }),
]);
type CreateCredentialEntryBody = z.infer<typeof CreateCredentialEntryBody>;
```

**Response:** `201 Created`

```typescript
interface CreateCredentialEntryResponse {
  id: string;
  key: string;
  type: CredentialEntryType;
  createdAt: string;
}
```

**Error cases:**
- `404 CREDENTIAL_SET_NOT_FOUND`
- `400 VALIDATION_ERROR`

**Side effects:**
1. Encrypts value with AES-256 before storage
2. Creates `credentialEntries` record
3. Writes `credentialAuditLog` entry (action: `create_entry`)

---

### 10.7 PATCH /api/credentials/:setId/entries/:entryId

**SRD refs:** FR-C2
**Description:** Update an existing credential entry's value, mount path, or command. Value is re-encrypted at rest.

**Request body:**

```typescript
const UpdateCredentialEntryBody = z.object({
  key: z.string().min(1).max(200).optional(),
  value: z.string().min(1).optional(),
  mountPath: z.string().min(1).nullable().optional(),
  command: z.string().min(1).nullable().optional(),
});
type UpdateCredentialEntryBody = z.infer<typeof UpdateCredentialEntryBody>;
```

**Response:** `200 OK`

```typescript
interface UpdateCredentialEntryResponse {
  id: string;
  key: string;
  value: '***';           // ALWAYS masked
  type: CredentialEntryType;
  mountPath: string | null;
  command: string | null;
  createdAt: string;
}
```

**Error cases:**
- `404 CREDENTIAL_SET_NOT_FOUND`
- `404 CREDENTIAL_ENTRY_NOT_FOUND`
- `400 VALIDATION_ERROR`

**Side effects:**
1. Re-encrypts value with AES-256 if changed
2. Updates `credentialEntries` record
3. Writes `credentialAuditLog` entry (action: `update_entry`)

---

### 10.8 DELETE /api/credentials/:setId/entries/:entryId

**SRD refs:** FR-C2
**Description:** Remove an entry from a credential set.

**Response:** `204 No Content`

**Error cases:**
- `404 CREDENTIAL_SET_NOT_FOUND`
- `404 CREDENTIAL_ENTRY_NOT_FOUND`

**Side effects:**
1. Deletes `credentialEntries` record
2. Writes `credentialAuditLog` entry (action: `delete_entry`)

---

### 10.9 GET /api/credentials/audit

**SRD refs:** FR-C5
**Description:** Get credential access audit log.

**Query parameters:**

```typescript
const AuditLogQuery = z.object({
  credentialSetId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type AuditLogQuery = z.infer<typeof AuditLogQuery>;
```

**Response:** `200 OK`

```typescript
interface AuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
}

interface AuditLogEntry {
  id: string;
  action: 'create_set' | 'delete_set' | 'create_entry' | 'update_entry' | 'delete_entry' | 'access_by_run';
  credentialSetId: string | null;
  credentialEntryId: string | null;
  workflowRunId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}
```

---

## 11. Stats, Health & Prerequisites

### 11.1 GET /api/stats

**SRD refs:** FR-D1, FR-D2
**Description:** Get workspace summary for the dashboard.

**Response:** `200 OK`

```typescript
interface StatsResponse {
  running: number;           // workflow runs currently running
  pendingReviews: number;    // reviews in pending_review status
  awaitingAction: number;    // runs in stage_failed, awaiting_proposals, etc.
  recentActivity: RecentActivity[];
}

interface RecentActivity {
  type: 'run_completed' | 'run_failed' | 'review_created' | 'run_started';
  runId: string;
  title: string | null;
  timestamp: string;
}
```

---

### 11.2 GET /health

**SRD refs:** NFR-O3
**Description:** Daemon health check. No authentication required.

**Response:** `200 OK`

```typescript
interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;    // seconds
  database: 'ok' | 'error';
}
```

---

### 11.3 GET /api/prerequisites

**SRD refs:** NFR-I4
**Description:** Check system prerequisites for running workflows.

**Response:** `200 OK`

```typescript
interface PrerequisitesResponse {
  allPassed: boolean;
  checks: PrerequisiteCheck[];
}

interface PrerequisiteCheck {
  name: 'docker' | 'docker_running' | 'docker_sandbox' | 'git' | 'github_auth' | 'sandbox_image';
  status: 'ok' | 'missing' | 'error';
  message: string;
  fixInstructions: string | null;
  version?: string;  // for docker, git
}
```

---

### 11.4 GET /api/last-run-config

**SRD refs:** —
**Description:** Get the last-used run configuration for GUI form pre-population. Returns the most recently used project, agent, credential set, and workflow template selections.

**Response:** `200 OK`

```typescript
interface LastRunConfigResponse {
  projectId: string | null;
  agentDefinitionId: string | null;
  credentialSetId: string | null;
  workflowTemplateId: string | null;
  updatedAt: string;
}
```

**Error cases:** None — returns null fields if no previous run exists.

---

## 12. WebSocket Protocol

### 12.1 Connection

**URL:** `ws://localhost:<port>/ws`
**Auth:** Bearer token as query param: `ws://localhost:<port>/ws?token=<auth_token>`

On connection, the server sends a `connected` message. The client must subscribe to specific runs to receive their output events.

### 12.2 Client → Server Messages

```typescript
// shared/types/events.ts

type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage;

interface SubscribeMessage {
  type: 'subscribe';
  runId: string;
  lastSeq?: number;  // replay events from this sequence number
}

interface UnsubscribeMessage {
  type: 'unsubscribe';
  runId: string;
}

interface PingMessage {
  type: 'ping';
}
```

**Subscribe behavior:**
- Client subscribes to a specific `runId` to receive streaming output
- If `lastSeq` is provided, server replays buffered events from that point (for reconnection — NFR-U6)
- Multiple subscriptions per connection supported (watching multiple runs)
- If event buffer has overflowed, server sends `resync_required` instead of replay

**Unsubscribe behavior:**
- Stops receiving `run_output` events for that run
- Global events (`run_status`, `review_created`, `notification`) continue regardless of subscriptions

### 12.3 Server → Client Messages

```typescript
type ServerMessage =
  | ConnectedMessage
  | RunOutputMessage
  | RunStatusMessage
  | StageStatusMessage
  | ReviewCreatedMessage
  | ProposalsReadyMessage
  | ConflictDetectedMessage
  | ResyncRequiredMessage
  | NotificationMessage
  | PongMessage;

// Connection acknowledgement
interface ConnectedMessage {
  type: 'connected';
  serverVersion: string;
}

// Agent output — only sent to clients subscribed to the run
interface RunOutputMessage {
  type: 'run_output';
  runId: string;
  seq: number;                // monotonic sequence number for replay
  stageName: string;
  round: number;
  data: AgentOutputEvent;
}

// Agent output event types (from ACP protocol)
interface AgentOutputEvent {
  role: 'assistant' | 'tool' | 'system' | 'user';
  content: string;
  eventType: 'agent_message' | 'agent_thought' | 'tool_call' | 'tool_result'
    | 'session_update' | 'result' | 'intervention' | 'system_prompt';
  metadata?: {
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    isStreaming?: boolean;     // true for partial messages during streaming
    usageStats?: UsageStats;
  };
  timestamp: string;
}

// Workflow run status change — broadcast to ALL connected clients
interface RunStatusMessage {
  type: 'run_status';
  runId: string;
  status: WorkflowRunStatus;
  currentStage: string | null;
  title: string | null;
  projectId: string;
}

// Stage status change — broadcast to ALL connected clients
interface StageStatusMessage {
  type: 'stage_status';
  runId: string;
  stageName: string;
  round: number;
  status: StageStatus;
  failureReason: string | null;
}

// Review created — broadcast to ALL connected clients
interface ReviewCreatedMessage {
  type: 'review_created';
  reviewId: string;
  runId: string;
  stageName: string | null;
  round: number;
  reviewType: 'stage' | 'consolidation';
}

// Split proposals ready for user review
interface ProposalsReadyMessage {
  type: 'proposals_ready';
  runId: string;
  stageName: string;
  proposalCount: number;
}

// Conflict detected during finalization or consolidation
interface ConflictDetectedMessage {
  type: 'conflict_detected';
  runId: string;
  conflictType: 'rebase' | 'merge';
  conflictDetails: string;
}

// Client must re-fetch via GET /api/runs/:id/messages (buffer overflow)
interface ResyncRequiredMessage {
  type: 'resync_required';
  runId: string;
  reason: string;
}

// Daemon-level notification
interface NotificationMessage {
  type: 'notification';
  level: 'info' | 'warning' | 'error';
  message: string;
  runId?: string;
}

// Keepalive response
interface PongMessage {
  type: 'pong';
}
```

### 12.4 Event Delivery Rules

| Event | Delivery | Trigger |
|-------|----------|---------|
| `run_output` | Subscribed clients only | ACP event from agent |
| `run_status` | All clients (broadcast) | Workflow status transition |
| `stage_status` | All clients (broadcast) | Stage execution start/complete/fail |
| `review_created` | All clients (broadcast) | `create-review` step completes |
| `proposals_ready` | All clients (broadcast) | `extract-proposals` step completes |
| `conflict_detected` | All clients (broadcast) | Rebase/merge conflict in finalize/consolidate |
| `resync_required` | Subscribed client | Event buffer overflow for that run |
| `notification` | All clients (broadcast) | Errors, warnings, informational |
| `pong` | Requesting client | Client sent `ping` |

### 12.5 Reconnection & Resync Protocol

**WebSocket reconnection sequence:**

1. Client detects WebSocket disconnect
2. Reconnects with exponential backoff (2s, 4s, 8s, max 30s)
3. Re-sends `subscribe` messages for all previously subscribed runs with `lastSeq`
4. Server replays missed events from in-memory buffer (bounded: 10,000 events per run)
5. If buffer has rolled over, server sends `resync_required` — client must perform a full resync (see below)

**Full resync strategy (on `resync_required` or initial load):**

After reconnection (or when `resync_required` is received), the client must re-fetch **all mutable state** — not just messages. The WebSocket only delivers incremental updates; the REST API is the source of truth for current state.

Required re-fetches on resync:

| API call | Purpose |
|----------|---------|
| `GET /api/runs/:id` | Current run status, currentStage, active review ID, stage list with statuses |
| `GET /api/runs/:id/messages?after=<lastMessageTimestamp>` | Conversation messages missed during disconnect |
| `GET /api/reviews?runId=:id` | Current review statuses (may have been approved/rejected while disconnected) |
| `GET /api/parallel-groups/:id` | If run has children: current group status and child statuses |

The client should perform these fetches in parallel immediately after re-subscribing. Until the fetches complete, the client should display a "Reconnecting…" indicator. After hydration, the client resumes processing incremental WebSocket events normally.

---

## 13. Authentication Middleware

**SRD refs:** NFR-S1, NFR-S2, NFR-S4

### 13.1 Token Management

```typescript
// daemon/src/lib/auth.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

const AUTH_TOKEN_PATH = join(CONFIG_DIR, 'auth.token');

export function getOrCreateAuthToken(): string {
  if (existsSync(AUTH_TOKEN_PATH)) {
    return readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  }
  const token = randomBytes(32).toString('hex'); // 256-bit
  writeFileSync(AUTH_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}
```

### 13.2 Hono Middleware

```typescript
// daemon/src/lib/auth.ts
import { createMiddleware } from 'hono/factory';

export function bearerAuth(token: string) {
  return createMiddleware(async (c, next) => {
    // Skip auth for health check
    if (c.req.path === '/health') {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } },
        401,
      );
    }

    const provided = authHeader.slice(7);
    if (provided !== token) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid auth token' } },
        401,
      );
    }

    await next();
  });
}
```

### 13.3 WebSocket Auth

```typescript
// daemon/src/ws/run-stream.ts
import { createBunWebSocket } from 'hono/bun';
// or: import { createNodeWebSocket } from '@hono/node-ws';

export function wsUpgradeAuth(token: string) {
  return createMiddleware(async (c, next) => {
    const queryToken = c.req.query('token');
    if (queryToken !== token) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid WebSocket auth token' } },
        401,
      );
    }
    await next();
  });
}
```

---

## 14. Hono Route Registration Pattern

### 14.1 App Setup

```typescript
// daemon/src/app.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bearerAuth, getOrCreateAuthToken } from './lib/auth';
import { runsRoutes } from './routes/runs';
import { projectsRoutes } from './routes/projects';
import { workflowsRoutes } from './routes/workflows';
import { reviewsRoutes } from './routes/reviews';
import { proposalsRoutes } from './routes/proposals';
import { parallelGroupsRoutes } from './routes/parallel-groups';
import { credentialsRoutes } from './routes/credentials';
import { agentsRoutes } from './routes/agents';
import { statsRoutes } from './routes/stats';
import { lastRunConfigRoute } from './routes/last-run-config';
import { healthRoute } from './routes/health';
import { prerequisitesRoute } from './routes/prerequisites';
import { wsRoute, wsUpgradeAuth } from './ws/run-stream';

const authToken = getOrCreateAuthToken();

const app = new Hono();

// Global middleware
app.use('*', cors({ origin: '*' }));  // localhost only, CORS permissive
app.use('*', logger());
app.use('/api/*', bearerAuth(authToken));
app.use('/ws', wsUpgradeAuth(authToken));

// Health (no auth)
app.route('/health', healthRoute);

// API routes
app.route('/api/runs', runsRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/workflows', workflowsRoutes);
app.route('/api/reviews', reviewsRoutes);
app.route('/api/proposals', proposalsRoutes);
app.route('/api/parallel-groups', parallelGroupsRoutes);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/agents', agentsRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/last-run-config', lastRunConfigRoute);
app.route('/api/prerequisites', prerequisitesRoute);

// WebSocket
app.route('/ws', wsRoute);

export { app };
```

### 14.2 Route Handler Pattern

Each route file follows this pattern — thin handlers that validate input with Zod, delegate to services, and map errors to HTTP responses:

```typescript
// daemon/src/routes/runs.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as runService from '../services/run-service';
import { mapServiceError } from '../lib/error-mapper';

export const runsRoutes = new Hono();

// GET /api/runs
runsRoutes.get(
  '/',
  zValidator('query', ListRunsQuery),
  async (c) => {
    const query = c.req.valid('query');
    const result = await runService.listRuns(query);
    return c.json(result, 200);
  },
);

// POST /api/runs
runsRoutes.post(
  '/',
  zValidator('json', CreateRunBody),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const run = await runService.createRun(body);
      return c.json(run, 201);
    } catch (err) {
      return mapServiceError(c, err);
    }
  },
);

// GET /api/runs/:id
runsRoutes.get('/:id', async (c) => {
  try {
    const run = await runService.getRun(c.req.param('id'));
    return c.json(run, 200);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// DELETE /api/runs/:id
runsRoutes.delete('/:id', async (c) => {
  try {
    await runService.deleteRun(c.req.param('id'));
    return c.body(null, 204);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// PATCH /api/runs/:id/cancel
runsRoutes.patch('/:id/cancel', async (c) => {
  try {
    const result = await runService.cancelRun(c.req.param('id'));
    return c.json(result, 200);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// POST /api/runs/:id/message
runsRoutes.post(
  '/:id/message',
  zValidator('json', SendMessageBody),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const result = await runService.sendMessage(c.req.param('id'), body);
      return c.json(result, 200);
    } catch (err) {
      return mapServiceError(c, err);
    }
  },
);

// GET /api/runs/:id/diff
runsRoutes.get('/:id/diff', async (c) => {
  try {
    const diff = await runService.getRunDiff(c.req.param('id'));
    return c.json(diff, 200);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// GET /api/runs/:id/messages
runsRoutes.get(
  '/:id/messages',
  zValidator('query', GetMessagesQuery),
  async (c) => {
    try {
      const query = c.req.valid('query');
      const messages = await runService.getMessages(c.req.param('id'), query);
      return c.json(messages, 200);
    } catch (err) {
      return mapServiceError(c, err);
    }
  },
);

// POST /api/runs/:id/retry-stage
runsRoutes.post('/:id/retry-stage', async (c) => {
  try {
    const result = await runService.retryStage(c.req.param('id'));
    return c.json(result, 200);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// POST /api/runs/:id/skip-stage
runsRoutes.post('/:id/skip-stage', async (c) => {
  try {
    const result = await runService.skipStage(c.req.param('id'));
    return c.json(result, 200);
  } catch (err) {
    return mapServiceError(c, err);
  }
});

// POST /api/runs/:id/resolve-conflict
runsRoutes.post(
  '/:id/resolve-conflict',
  zValidator('json', ResolveConflictBody),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const result = await runService.resolveConflict(c.req.param('id'), body);
      return c.json(result, 200);
    } catch (err) {
      return mapServiceError(c, err);
    }
  },
);
```

### 14.3 Error Mapper

```typescript
// daemon/src/lib/error-mapper.ts
import type { Context } from 'hono';

// Base class for all service errors
export class ServiceError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class NotFoundError extends ServiceError {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 404);
  }
}

export class ConflictError extends ServiceError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export function mapServiceError(c: Context, err: unknown) {
  if (err instanceof ServiceError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      },
      err.statusCode as any,
    );
  }

  // Unexpected error
  console.error('Unexpected error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    },
    500,
  );
}
```

### 14.4 WebSocket Handler

```typescript
// daemon/src/ws/run-stream.ts
import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { ServerMessage, ClientMessage } from 'shared/types/events';
import { streamingService } from '../services/streaming-service';

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

export const wsRoute = new Hono();

wsRoute.get(
  '/',
  upgradeWebSocket((c) => ({
    onOpen(evt, ws) {
      const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
      send({ type: 'connected', serverVersion: process.env.VERSION ?? '0.0.0' });

      // Register for global broadcasts
      streamingService.addClient(ws, send);
    },

    onMessage(evt, ws) {
      try {
        const msg: ClientMessage = JSON.parse(evt.data as string);

        switch (msg.type) {
          case 'subscribe':
            streamingService.subscribe(ws, msg.runId, msg.lastSeq);
            break;
          case 'unsubscribe':
            streamingService.unsubscribe(ws, msg.runId);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    },

    onClose(evt, ws) {
      streamingService.removeClient(ws);
    },
  })),
);

export { injectWebSocket };
```

---

## 15. Zod Validation Middleware Pattern

All request bodies and query parameters are validated at the route level using `@hono/zod-validator`. Validation failures return `400` with structured error details:

```typescript
// Zod validation error response format (automatic from @hono/zod-validator)
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "issues": [
        {
          "path": ["description"],
          "message": "Required",
          "code": "invalid_type"
        }
      ]
    }
  }
}
```

Custom Zod validation hook to match our error envelope:

```typescript
// daemon/src/lib/validation.ts
import { z } from 'zod';
import type { ValidationTargets } from 'hono';

export function zodHook(result: { success: boolean; error?: z.ZodError }, c: any) {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: { issues: result.error!.issues },
        },
      },
      400,
    );
  }
}

// Usage: zValidator('json', Schema, zodHook)
```

---

## 16. SRD Traceability Matrix

| Endpoint | SRD Requirements |
|----------|-----------------|
| `POST /api/runs` | FR-W3, FR-W4, FR-W13, FR-W17, FR-W18, FR-W22 |
| `GET /api/runs` | FR-D2, FR-D3 |
| `GET /api/runs/:id` | FR-W16 |
| `DELETE /api/runs/:id` | — |
| `PATCH /api/runs/:id/cancel` | FR-W10 |
| `POST /api/runs/:id/message` | FR-W21 |
| `GET /api/runs/:id/diff` | FR-R2 |
| `GET /api/runs/:id/messages` | FR-W16, FR-W19 |
| `POST /api/runs/:id/retry-stage` | FR-W14 |
| `POST /api/runs/:id/skip-stage` | FR-W14 |
| `POST /api/runs/:id/resolve-conflict` | FR-R10, FR-S10 |
| `GET /api/workflows` | FR-W1, FR-W11, FR-W12 |
| `POST /api/workflows` | FR-W1, FR-W2 |
| `GET /api/workflows/:id` | FR-W12 |
| `PUT /api/workflows/:id` | FR-W12 |
| `DELETE /api/workflows/:id` | FR-W12 |
| `GET /api/reviews` | FR-R1, FR-R9 |
| `GET /api/reviews/:id` | FR-R2, FR-R3, FR-R11 |
| `POST /api/reviews/:id/approve` | FR-R6, FR-R10, NFR-R5 |
| `POST /api/reviews/:id/request-changes` | FR-R7, FR-R8 |
| `POST /api/reviews/:id/comments` | FR-R4, FR-R5 |
| `GET /api/reviews/:id/comments` | FR-R4, FR-R5 |
| `GET /api/proposals` | FR-S1, FR-S3 |
| `POST /api/proposals` | FR-S3 |
| `GET /api/proposals/:id` | FR-S3 |
| `PUT /api/proposals/:id` | FR-S3 |
| `DELETE /api/proposals/:id` | FR-S3 |
| `POST /api/proposals/launch` | FR-S4, FR-S5, FR-S6 |
| `GET /api/parallel-groups/:id` | FR-S7 |
| `POST /api/parallel-groups/:id/consolidate` | FR-S8, FR-S9 |
| `POST /api/parallel-groups/:id/consolidate-partial` | FR-S8, FR-S12 |
| `POST /api/parallel-groups/:id/retry-children` | FR-S12 |
| `POST /api/parallel-groups/:id/cancel` | FR-S7 |
| `GET /api/projects` | FR-P2 |
| `POST /api/projects` | FR-P1, FR-P7 |
| `GET /api/projects/:id` | FR-P1 |
| `PATCH /api/projects/:id` | FR-P4, FR-P6 |
| `DELETE /api/projects/:id` | FR-P3 |
| `GET /api/projects/:id/branches` | FR-P5 |
| `GET /api/agents` | FR-A2 |
| `GET /api/agents/:id` | FR-A2 |
| `POST /api/agents` | FR-A1 |
| `PUT /api/agents/:id` | FR-A2 |
| `DELETE /api/agents/:id` | FR-A2 |
| `GET /api/credentials` | FR-C1, FR-C6 |
| `POST /api/credentials` | FR-C1 |
| `GET /api/credentials/:id` | FR-C1, FR-C7 |
| `PATCH /api/credentials/:id` | FR-C1 |
| `DELETE /api/credentials/:id` | FR-C1 |
| `POST /api/credentials/:id/entries` | FR-C2, FR-C3 |
| `PATCH /api/credentials/:setId/entries/:entryId` | FR-C2 |
| `DELETE /api/credentials/:setId/entries/:entryId` | FR-C2 |
| `GET /api/credentials/audit` | FR-C5 |
| `GET /api/stats` | FR-D1, FR-D2 |
| `GET /api/last-run-config` | — |
| `GET /health` | NFR-O3 |
| `GET /api/prerequisites` | NFR-I4 |
| WebSocket `/ws` | FR-W15, FR-W20, NFR-P1, NFR-U6 |
| Auth middleware | NFR-S1, NFR-S2 |
| Error format | SAD §3.1 |

---

## 17. Endpoint Count Summary

| Group | Count | Endpoints |
|-------|-------|-----------|
| Runs | 11 | GET list, POST create, GET detail, DELETE, PATCH cancel, POST message, GET diff, GET messages, POST retry-stage, POST skip-stage, POST resolve-conflict |
| Workflows | 5 | GET list, POST create, GET detail, PUT update, DELETE |
| Reviews | 6 | GET list, GET detail, POST approve, POST request-changes, POST comments, GET comments |
| Proposals | 6 | GET list, POST create, GET detail, PUT update, DELETE, POST launch |
| Parallel Groups | 5 | GET status, POST consolidate, POST consolidate-partial, POST retry-children, POST cancel |
| Projects | 6 | GET list, POST create, GET detail, PATCH update, DELETE, GET branches |
| Agents | 5 | GET list, GET detail, POST create, PUT update, DELETE |
| Credentials | 9 | GET sets, POST set, GET set, PATCH set, DELETE set, POST entry, PATCH entry, DELETE entry, GET audit |
| Stats | 1 | GET stats |
| Last Run Config | 1 | GET last-run-config |
| Health | 1 | GET health |
| Prerequisites | 1 | GET prerequisites |
| WebSocket | 1 | WS /ws |
| **Total** | **58** | |
