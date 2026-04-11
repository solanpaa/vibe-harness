# Vibe Harness v2 — Solution Architecture Design (SAD)

## 1. Architecture Overview

### 1.1 System Context

Vibe Harness v2 is a desktop-native AI coding agent orchestrator. It consists of three components communicating over local transport:

```
┌──────────────────────────────────────────────────────────────────┐
│  User's Machine                                                  │
│                                                                  │
│  ┌─────────────────┐         ┌──────────────────────────────┐   │
│  │  Tauri GUI       │  HTTP   │  Daemon Process              │   │
│  │  (React + Vite)  │◄──────►│  (Node.js + Hono + Nitro)    │   │
│  │                  │  WS     │                              │   │
│  │  Port file:      │         │  ┌────────────────────────┐  │   │
│  │  ~/.vibe-harness/ │         │  │  use workflow engine   │  │   │
│  │    daemon.port   │         │  │  (durable orchestration)│  │   │
│  └────────┬────────┘         │  └────────────────────────┘  │   │
│           │                   │  ┌────────────────────────┐  │   │
│    Tauri  │ sidecar           │  │  Services              │  │   │
│    starts │ manages           │  │  (sandbox, ACP, git)   │  │   │
│           ▼                   │  └────────────────────────┘  │   │
│  ┌─────────────────┐         │  ┌────────────────────────┐  │   │
│  │  Daemon Binary   │         │  │  SQLite + Drizzle      │  │   │
│  │  (sidecar)      │─────────►│  │  ~/.vibe-harness/      │  │   │
│  └─────────────────┘         │  │    vibe-harness.db     │  │   │
│                               │  └────────────────────────┘  │   │
│  ┌─────────────────┐         │                              │   │
│  │  CLI (post-MVP) │  Unix   │  ┌────────────────────────┐  │   │
│  │                  │  socket │  │  .workflow-data/        │  │   │
│  │                  │◄──────►│  │  (workflow event log)   │  │   │
│  └─────────────────┘         └──────────────────────────────┘   │
│                                          │                       │
│                                          │ docker sandbox run    │
│                                          ▼                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Docker Sandbox(es)                                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │   │
│  │  │ Run A    │  │ Run B    │  │ Run N    │               │   │
│  │  │ Copilot  │  │ Copilot  │  │ Copilot  │               │   │
│  │  │ CLI      │  │ CLI      │  │ CLI      │               │   │
│  │  └──────────┘  └──────────┘  └──────────┘               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Git Repositories (user's local repos)                    │   │
│  │  ├── project-a/                                           │   │
│  │  │   └── .vibe-harness-worktrees/                        │   │
│  │  │       ├── fix-login-bug/       (run worktree)          │   │
│  │  │       └── split-auth-refactor/ (split child worktree)  │   │
│  │  └── project-b/                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Summary

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Daemon** | All business logic, state management, agent orchestration | Node.js, Hono, Nitro, `use workflow`, Drizzle+SQLite |
| **GUI** | Presentation only — renders state, sends commands | Tauri 2.0, React, Vite, Streamdown |
| **CLI** (post-MVP) | Thin client — same commands as GUI, terminal output | Node.js, Unix socket client |
| **Docker Sandboxes** | Isolated agent execution environments | `docker sandbox run`, custom image |
| **Git Worktrees** | Branch isolation per workflow run | `git worktree add/remove` |

### 1.3 Key Architectural Principles

1. **Daemon is the single source of truth.** All state lives in the daemon (SQLite + workflow event log). GUI and CLI are stateless presentation layers.
2. **Workflow orchestration and stage execution are unified.** `use workflow` drives stage progression; workflow steps directly manage ACP sessions within shared sandboxes. There is no separate "task runtime" layer.
3. **All mutations go through the daemon API.** No direct DB access from GUI. No state mutations in the client.
4. **Streaming is push-based.** Agent output flows: Docker stdio → daemon ACP client → WebSocket → GUI. GUI subscribes, daemon pushes.
5. **Idempotent commands.** All mutating API operations are safe to retry.
6. **Continuous conversation by default.** Within a workflow run, the agent's ACP session persists across stages (`--continue`). `freshSession` marks a boundary but prior messages are always retained in the log.

---

## 2. Component Architecture

### 2.1 Daemon

The daemon is a long-running Node.js process that exposes an HTTP+WS API and manages all backend concerns.

#### 2.1.1 Internal Module Structure

```
daemon/
├── src/
│   ├── index.ts                 # Entry: Nitro-wrapped Hono server
│   ├── app.ts                   # Hono app: middleware + route registration
│   │
│   ├── routes/                  # HTTP API layer (thin — delegates to services)
│   │   ├── runs.ts              # /api/runs/*
│   │   ├── projects.ts          # /api/projects/*
│   │   ├── workflows.ts         # /api/workflows/*
│   │   ├── reviews.ts           # /api/reviews/*
│   │   ├── proposals.ts         # /api/proposals/*
│   │   ├── credentials.ts       # /api/credentials/*
│   │   ├── agents.ts            # /api/agents/*
│   │   └── stats.ts             # /api/stats
│   │
│   ├── ws/                      # WebSocket handlers
│   │   └── run-stream.ts        # Per-run streaming: agent output + status events
│   │
│   ├── workflows/               # use workflow definitions
│   │   ├── pipeline.ts          # Main: runWorkflowPipeline()
│   │   ├── hooks.ts             # defineHook() for review/proposal/merge gates
│   │   └── steps/               # "use step" implementations
│   │       ├── execute-stage.ts # Send prompt, manage ACP session, await completion
│   │       ├── create-review.ts # Generate diff, create review record
│   │       ├── inject-comments.ts # Bundle review comments, send into conversation
│   │       ├── extract-proposals.ts # Parse split agent output
│   │       ├── launch-children.ts   # Create parallel group + child workflows
│   │       ├── consolidate.ts       # Merge child branches
│   │       └── finalize.ts          # Final commit/rebase/merge
│   │
│   ├── services/                # Core business logic (framework-agnostic)
│   │   ├── session-manager.ts   # ACP session lifecycle: create, continue, fresh, stop
│   │   ├── sandbox.ts           # Docker sandbox: create, exec, stop, list (per run)
│   │   ├── worktree.ts          # Git worktree: create, diff, merge, cleanup (per run)
│   │   ├── acp-client.ts        # ACP protocol: NDJSON over stdio
│   │   ├── review-service.ts    # Diff generation, AI summary, plan capture
│   │   ├── credential-vault.ts  # Encrypt/decrypt, inject into sandbox
│   │   ├── proposal-service.ts  # CRUD for split proposals
│   │   ├── diff-parser.ts       # Unified diff → structured DiffFile[]
│   │   ├── branch-namer.ts      # LLM-generated branch names + sanitization
│   │   └── title-generator.ts   # Auto-generate titles from prompts
│   │
│   ├── db/                      # Persistence
│   │   ├── index.ts             # Drizzle client, connection, WAL mode
│   │   ├── schema.ts            # All table definitions
│   │   └── migrations/          # drizzle-kit generated
│   │
│   └── lib/                     # Utilities
│       ├── config.ts            # Paths, ports, auth token management
│       ├── encryption.ts        # AES-256 encrypt/decrypt
│       ├── auth.ts              # Token generation, Bearer middleware
│       ├── logger.ts            # Structured JSON logging (pino)
│       └── reconcile.ts         # Startup: sandbox/run reconciliation
```

#### 2.1.2 Daemon Lifecycle

```
Start:
  1. Read/create config directory (~/.vibe-harness/)
  2. Generate auth token if first run
  3. Initialize SQLite + run migrations
  4. Reconcile orphaned sandboxes/runs (NFR-R3)
  5. Pick available port, write to daemon.port file
  6. Write PID to daemon.pid file
  7. Start Hono HTTP server on localhost:<port>
  8. Start Unix socket listener at daemon.sock (post-MVP)
  9. Log "daemon ready" with port

Shutdown (SIGTERM/SIGINT):
  1. Stop accepting new connections
  2. Close all WebSocket connections
  3. Send ACP stop to all running stages; force-kill after 30s timeout
  4. Stop all Docker sandboxes (best-effort)
  5. Close database connection
  6. Remove daemon.port and daemon.pid files

Single-instance:
  On start, check daemon.pid — if another daemon is running, exit with error.
```

#### 2.1.3 Startup Reconciliation (NFR-R3)

```
On daemon start:
  1. docker sandbox ls --filter name=vibe-* → list of live sandboxes
  2. SELECT * FROM workflowRuns WHERE status IN ('running', 'provisioning')
  3. For each running/provisioning run:
     - Read current stageExecution in 'running' state
     - Mark stageExecution failed (reason: "daemon_restart")
     - Transition workflowRun to 'stage_failed' status
     - If matching sandbox exists: stop the sandbox
     - If no sandbox: already handled by status transition above
  4. For each live sandbox with no matching active run: stop sandbox (orphan)
  5. Workflow hooks at suspension points remain intact (.workflow-data/)
  6. Retry pending hook resumes (see §5.4.1):
     SELECT * FROM hookResumes
     For each: retry resumeHook() — ensures no stuck workflows from
     partially-completed approve/reject operations
  7. Log reconciliation summary
```

### 2.2 GUI (Tauri + React)

The GUI is a native desktop application that communicates with the daemon exclusively via HTTP REST and WebSocket. It contains zero business logic.

#### 2.2.1 Internal Structure

```
gui/
├── src-tauri/                   # Rust shell (minimal)
│   ├── src/
│   │   ├── lib.rs               # Sidecar management + port discovery
│   │   └── main.rs              # Tauri entry point
│   └── tauri.conf.json          # Sidecar config, window settings
│
├── src/                         # React frontend
│   ├── main.tsx                 # App entry
│   ├── App.tsx                  # Router + layout
│   │
│   ├── api/                     # Daemon communication
│   │   ├── client.ts            # Typed REST client (from shared types)
│   │   └── ws.ts                # WebSocket manager (reconnect, replay)
│   │
│   ├── stores/                  # Client state (Zustand)
│   │   ├── workspace.ts         # Run list, selected item, filters
│   │   ├── streaming.ts         # Per-run streaming output buffer
│   │   └── daemon.ts            # Connection status, health
│   │
│   ├── pages/
│   │   ├── Workspace.tsx        # Main: run feed + detail panel
│   │   ├── Projects.tsx         # Project CRUD
│   │   ├── Workflows.tsx        # Template editor + run list
│   │   ├── Credentials.tsx      # Vault management
│   │   └── Settings.tsx         # Agent definitions, preferences
│   │
│   ├── components/
│   │   ├── run/
│   │   │   ├── RunFeed.tsx            # Filterable workflow run list
│   │   │   ├── RunDetail.tsx          # Full run view: stages + conversation + streaming
│   │   │   ├── RunConversation.tsx    # Continuous message history across stages
│   │   │   └── NewRunModal.tsx        # Workflow run creation form
│   │   ├── review/
│   │   │   ├── ReviewPanel.tsx        # Diff + comments + approve/reject
│   │   │   ├── DiffViewer.tsx         # Unified diff with file tree
│   │   │   ├── FileTree.tsx           # Navigable file list from diff
│   │   │   ├── InlineComment.tsx      # Per-line comment component
│   │   │   └── ReviewHeader.tsx       # Round selector, status, actions
│   │   ├── workflow/
│   │   │   ├── StageVisualization.tsx # Pipeline progress display
│   │   │   └── ProposalPanel.tsx      # Split proposal editor
│   │   └── shared/
│   │       ├── CommandPalette.tsx      # ⌘K search
│   │       ├── StatusBadge.tsx         # Run/stage/review status
│   │       ├── DaemonStatus.tsx        # Connection indicator
│   │       └── PrerequisiteCheck.tsx   # First-launch setup guide
│   │
│   └── hooks/
│       ├── useWebSocket.ts      # WS connection with auto-reconnect + replay
│       ├── useDaemonApi.ts      # Typed REST hooks (SWR or react-query)
│       └── useKeyboardShortcuts.ts
```

#### 2.2.2 Multi-Window Architecture

Tauri supports multiple `WebviewWindow` instances. This is a primary v2 feature (NFR-U1).

**Window types:**
- **Main window** — Workspace: run feed + detail panel (always open)
- **Detached detail windows** — Run detail, Review panel, or Workflow view popped out into separate OS windows

**Architecture:**
```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  Main Window          │   │  Detached Window 1    │   │  Detached Window 2    │
│  (Workspace)          │   │  (Run Detail #42)     │   │  (Review #17)         │
│                       │   │                       │   │                       │
│  ┌─────────────────┐  │   │  ┌─────────────────┐  │   │  ┌─────────────────┐  │
│  │ Zustand Store   │  │   │  │ Zustand Store   │  │   │  │ Zustand Store   │  │
│  │ (independent)   │  │   │  │ (independent)   │  │   │  │ (independent)   │  │
│  └────────┬────────┘  │   │  └────────┬────────┘  │   │  └────────┬────────┘  │
│           │            │   │           │            │   │           │            │
│  ┌────────▼────────┐  │   │  ┌────────▼────────┐  │   │  ┌────────▼────────┐  │
│  │ WebSocket conn  │  │   │  │ WebSocket conn  │  │   │  │ WebSocket conn  │  │
│  │ (own connection)│  │   │  │ (own connection)│  │   │  │ (own connection)│  │
│  └─────────────────┘  │   │  └─────────────────┘  │   │  └─────────────────┘  │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘
         │                           │                           │
         └───────────────────────────┴───────────────────────────┘
                              Daemon (localhost HTTP + WS)
```

**State model:**
- Each Tauri window is a separate webview with its own JavaScript context
- Each window gets its own Zustand store instance (no cross-window shared state)
- Each window establishes its own WebSocket connection to the daemon
- Windows hydrate their state from REST API on open, then stay in sync via WS events
- The daemon is the consistency layer — all windows see the same state because they all read from the same daemon

**Window lifecycle:**
- User right-clicks run → "Open in New Window" → Tauri creates `new WebviewWindow({ url: '/run/42' })`
- New window bootstraps: read auth token, connect WS, fetch run data, subscribe to run stream
- Main window's run feed continues to show status updates for all runs (including detached ones)
- Closing a detached window has no effect on the workflow — daemon keeps running

**Broadcast:**
- Global notifications (workflow_status, review_created) are broadcast to ALL connected WS clients
- Run-specific output events go only to windows subscribed to that runId
- This means multiple windows viewing the same run all get the same stream

#### 2.2.3 Tauri Sidecar Lifecycle

```
Tauri app start:
  1. Check if daemon already running (read daemon.pid, check if process alive)
  2. If not running: spawn daemon as Tauri sidecar process
  3. Wait for daemon.port file to appear (poll, timeout 30s)
  4. Read port, establish HTTP + WS connection
  5. Verify auth token (read from ~/.vibe-harness/auth.token)
  6. Show main window

Daemon connection lost:
  1. GUI shows "Daemon disconnected" banner (NFR-U6)
  2. Auto-retry connection every 2s with exponential backoff
  3. If sidecar process died: restart sidecar
  4. On reconnect: re-fetch current state, replay missed WS events

Tauri app close:
  1. GUI closes all windows
  2. Daemon sidecar continues running (daemon survives GUI close)
  3. Daemon stays alive for background workflow execution
  4. User can explicitly stop daemon from settings or system tray
```

#### 2.2.4 Streaming Architecture

```
Agent output flow:
  Docker sandbox stdout
    → ACP client (NDJSON parsing, event extraction)
    → StreamingService (per-run event buffer with sequence numbers)
    ├──→ DB writer (persists every ACP event to runMessages table — FR-W19)
    └──→ WebSocket (push to all connected clients subscribed to runId)
         → Zustand streaming store (append to buffer)
         → RunConversation component (Streamdown renders markdown)

DB writer:
  Each ACP event (agent_message, tool_call, tool_result, agent_thought,
  session_update, result) is inserted into runMessages with:
  - role, content, metadata (JSON), stageName, sessionIndex, createdAt
  DB writes are batched (flush every 500ms or 50 events, whichever comes first)
  to avoid per-event write overhead on SQLite.

Reconnection:
  GUI sends last-seen sequence number on WS reconnect.
  Daemon replays events from that point forward.
  Buffer is bounded (configurable, default 10,000 events per run).
  If buffer overflows, client receives 'resync_required' event and must
  re-fetch from runMessages via GET /api/runs/:id/messages.
```

### 2.3 Shared Types Package

```
shared/
├── package.json
├── types/
│   ├── entities.ts      # Project, WorkflowRun, StageExecution, Review, etc.
│   ├── api.ts           # Request/response shapes for every endpoint
│   ├── events.ts        # WebSocket event types
│   └── enums.ts         # WorkflowRunStatus, StageStatus, ReviewStatus, etc.
└── index.ts             # Re-exports
```

Used by both `daemon/` and `gui/` as a workspace dependency. Changes to API contracts are type-checked at build time in both consumers.

---

## 3. Communication Architecture

### 3.1 GUI ↔ Daemon: REST API

All CRUD operations use standard REST over HTTP localhost.

**Authentication:** Bearer token in `Authorization` header. Token read from `~/.vibe-harness/auth.token` by GUI (via Tauri file access) and CLI.

**Content type:** JSON request/response bodies.

**Error format:**
```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "Workflow run with ID abc-123 does not exist",
    "details": {}
  }
}
```

### 3.2 GUI ↔ Daemon: WebSocket Streaming

Single WebSocket connection per GUI instance at `ws://localhost:<port>/ws`.

**Protocol:**
```typescript
// Client → Daemon
type ClientMessage =
  | { type: 'subscribe'; runId: string; lastSeq?: number }
  | { type: 'unsubscribe'; runId: string }

// Daemon → Client
type ServerMessage =
  | { type: 'run_output'; runId: string; seq: number; stage: string; data: AgentOutputEvent }
  | { type: 'run_status'; runId: string; status: WorkflowRunStatus; stage?: string }
  | { type: 'stage_status'; runId: string; stage: string; status: StageStatus }
  | { type: 'review_created'; reviewId: string; runId: string; stage: string }
  | { type: 'notification'; level: 'info' | 'warning' | 'error'; message: string }
```

Clients subscribe to specific workflow run streams. Daemon pushes events for subscribed runs plus global notifications (workflow status changes, review creation, stage completion).

### 3.3 Daemon ↔ Docker Sandbox: ACP Protocol

Communication with Copilot CLI uses the Agent Client Protocol over stdio:

```
Daemon                          Docker Sandbox (Copilot CLI)
  │                                      │
  │── docker sandbox create ────────────►│
  │── docker sandbox network proxy ─────►│
  │── docker sandbox exec -i ... ───────►│  (spawns copilot --acp --stdio)
  │                                      │
  │◄── NDJSON event stream (stdout) ─────│  (agent_message, tool_call, etc.)
  │── NDJSON prompt (stdin) ────────────►│  (user messages, interventions)
  │                                      │
  │── ACP stop ─────────────────────────►│  (on cancel — graceful stop)
  │   (30s timeout, then force-kill)     │
  │◄── exit code ────────────────────────│
```

**ACP events parsed:** agent_message, agent_thought, tool_call, tool_result, session_update, result (usage stats).

**Session continuity:** Within a workflow run, subsequent stages use `--continue` to resume the ACP session. The sandbox stays alive across stages. The `session-manager` service tracks session state and decides whether to continue or start fresh based on the stage's `freshSession` setting.

### 3.4 CLI ↔ Daemon: Unix Socket (post-MVP)

Same REST API as HTTP, transported over Unix domain socket at `~/.vibe-harness/daemon.sock`. Same auth token. Avoids port conflicts and is marginally faster.

---

## 4. Data Architecture

### 4.1 Persistence Model

Two independent storage systems, each owning distinct state:

```
┌───────────────────────────────────┐  ┌──────────────────────────────┐
│  SQLite (Drizzle ORM)             │  │  .workflow-data/ (Local World)│
│  ~/.vibe-harness/vibe-harness.db  │  │  ~/.vibe-harness/            │
│                                   │  │    .workflow-data/            │
│  Owns:                            │  │                              │
│  • Projects                       │  │  Owns:                       │
│  • Agent definitions              │  │  • Workflow run state         │
│  • Workflow runs + stage state    │  │  • Step execution log        │
│  • Run messages (conversation)    │  │  • Hook state (suspended)    │
│  • Reviews + comments             │  │  • Deterministic replay data │
│  • Proposals                      │  │                              │
│  • Parallel groups                │  │  Format: JSON files per run  │
│  • Credential sets + entries      │  │  Managed by: use workflow    │
│  • Credential audit log           │  │                              │
│  • Last run config                │  │  NOT directly accessed by    │
│                                   │  │  daemon code — only through  │
│  Accessed by: daemon services     │  │  workflow SDK APIs           │
│  via Drizzle query builder        │  │                              │
└───────────────────────────────────┘  └──────────────────────────────┘
```

**Consistency rule:** SQLite is the source of truth for entity state (run status, stage status, review status). Workflow event log is the source of truth for orchestration progression. The `"use step"` functions bridge between them — they read/write SQLite as side effects of workflow steps.

**Failure scenario:** If daemon crashes after a workflow step updates SQLite but before the workflow runtime records step completion → on restart, the step will re-execute (replay). Steps must be **idempotent** — re-creating an already-existing review should be a no-op, re-sending a prompt to an already-completed stage should return the cached result.

### 4.2 Database Schema (SQLite)

```
projects
  id TEXT PK
  name TEXT NOT NULL
  gitUrl TEXT
  localPath TEXT NOT NULL
  description TEXT
  defaultCredentialSetId TEXT FK → credentialSets.id
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

agentDefinitions
  id TEXT PK
  name TEXT NOT NULL
  type TEXT NOT NULL  -- 'copilot_cli' (only for MVP)
  commandTemplate TEXT NOT NULL
  dockerImage TEXT
  description TEXT
  supportsStreaming INTEGER NOT NULL DEFAULT 1
  supportsContinue INTEGER NOT NULL DEFAULT 1
  supportsIntervention INTEGER NOT NULL DEFAULT 1
  outputFormat TEXT NOT NULL DEFAULT 'acp'  -- 'acp' | 'jsonl' | 'text'
  createdAt TEXT NOT NULL

workflowTemplates
  id TEXT PK
  name TEXT NOT NULL
  description TEXT
  stages TEXT NOT NULL  -- JSON: WorkflowStage[]
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

workflowRuns
  id TEXT PK
  workflowTemplateId TEXT NOT NULL FK → workflowTemplates.id
  projectId TEXT NOT NULL FK → projects.id
  agentDefinitionId TEXT NOT NULL FK → agentDefinitions.id
  parentRunId TEXT FK → workflowRuns.id  -- non-NULL for split children
  parallelGroupId TEXT FK → parallelGroups.id  -- non-NULL for split children
  description TEXT  -- user's run description
  title TEXT  -- auto-generated or user-provided
  status TEXT NOT NULL DEFAULT 'pending'
  currentStage TEXT
  sandboxId TEXT  -- Docker sandbox name (shared across all stages)
  worktreePath TEXT  -- filesystem path to worktree (shared across all stages)
  branch TEXT  -- LLM-generated branch name
  acpSessionId TEXT  -- current ACP session (shared across non-fresh stages)
  credentialSetId TEXT FK → credentialSets.id
  baseBranch TEXT  -- branch worktree was created from
  targetBranch TEXT  -- branch to merge into on approval
  createdAt TEXT NOT NULL
  completedAt TEXT

stageExecutions
  id TEXT PK
  workflowRunId TEXT NOT NULL FK → workflowRuns.id
  stageName TEXT NOT NULL
  round INTEGER NOT NULL DEFAULT 1  -- increments on request_changes
  status TEXT NOT NULL DEFAULT 'pending'
  prompt TEXT  -- built prompt for this stage+round
  freshSession INTEGER NOT NULL DEFAULT 0  -- was a new ACP session started?
  startedAt TEXT
  completedAt TEXT
  failureReason TEXT  -- 'daemon_restart' | 'agent_error' | ...
  usageStats TEXT  -- JSON: {tokens, duration, cost, model}

  UNIQUE(workflowRunId, stageName, round)  -- idempotency

runMessages
  id TEXT PK
  workflowRunId TEXT NOT NULL FK → workflowRuns.id ON DELETE CASCADE
  stageName TEXT NOT NULL  -- which stage this message belongs to
  round INTEGER NOT NULL DEFAULT 1
  sessionBoundary INTEGER NOT NULL DEFAULT 0  -- marks freshSession reset
  role TEXT NOT NULL  -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL
  isIntervention INTEGER NOT NULL DEFAULT 0
  metadata TEXT  -- JSON: tool calls, reasoning, thought content
  createdAt TEXT NOT NULL

reviews
  id TEXT PK
  workflowRunId TEXT NOT NULL FK → workflowRuns.id
  stageName TEXT  -- NULL for consolidation reviews
  round INTEGER NOT NULL DEFAULT 1
  type TEXT NOT NULL DEFAULT 'stage'  -- 'stage' | 'consolidation'
  status TEXT NOT NULL DEFAULT 'pending_review'
  aiSummary TEXT
  diffSnapshot TEXT
  planMarkdown TEXT
  createdAt TEXT NOT NULL

  UNIQUE(workflowRunId, stageName, round, type)  -- idempotency (stageName NULL for consolidation)

reviewComments
  id TEXT PK
  reviewId TEXT NOT NULL FK → reviews.id ON DELETE CASCADE
  filePath TEXT  -- NULL for general (non-file-specific) comments
  lineNumber INTEGER
  side TEXT  -- 'left' | 'right'
  body TEXT NOT NULL
  createdAt TEXT NOT NULL

proposals
  id TEXT PK
  workflowRunId TEXT NOT NULL FK → workflowRuns.id ON DELETE CASCADE
  stageName TEXT NOT NULL  -- the split stage that generated this proposal
  parallelGroupId TEXT FK → parallelGroups.id
  title TEXT NOT NULL
  description TEXT NOT NULL
  affectedFiles TEXT  -- JSON: string[]
  dependsOn TEXT  -- JSON: string[] (metadata only, not enforced)
  workflowTemplateOverride TEXT FK → workflowTemplates.id
  status TEXT NOT NULL DEFAULT 'proposed'
  launchedWorkflowRunId TEXT FK → workflowRuns.id
  sortOrder INTEGER NOT NULL DEFAULT 0
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(workflowRunId, stageName, title)  -- idempotency

parallelGroups
  id TEXT PK
  sourceWorkflowRunId TEXT NOT NULL FK → workflowRuns.id
  name TEXT
  description TEXT
  status TEXT NOT NULL DEFAULT 'pending'
  createdAt TEXT NOT NULL
  completedAt TEXT

credentialSets
  id TEXT PK
  name TEXT NOT NULL
  description TEXT
  projectId TEXT FK → projects.id ON DELETE SET NULL
  createdAt TEXT NOT NULL

credentialEntries
  id TEXT PK
  credentialSetId TEXT NOT NULL FK → credentialSets.id ON DELETE CASCADE
  key TEXT NOT NULL
  value TEXT NOT NULL  -- encrypted (AES-256)
  type TEXT NOT NULL  -- 'env_var' | 'file_mount' | 'docker_login'
  mountPath TEXT
  createdAt TEXT NOT NULL

credentialAuditLog
  id TEXT PK
  action TEXT NOT NULL
  credentialSetId TEXT
  credentialEntryId TEXT
  workflowRunId TEXT
  details TEXT  -- JSON
  createdAt TEXT NOT NULL

lastRunConfig
  id INTEGER PK DEFAULT 1  -- singleton
  projectId TEXT
  agentDefinitionId TEXT
  credentialSetId TEXT
  workflowTemplateId TEXT
  updatedAt TEXT NOT NULL

hookResumes
  id TEXT PK
  hookToken TEXT NOT NULL UNIQUE
  action TEXT NOT NULL  -- JSON payload sent to resumeHook
  createdAt TEXT NOT NULL
  -- Outbox pattern: written before resumeHook(), deleted after success
  -- Startup reconciler retries any remaining entries

gitOperations
  id TEXT PK
  type TEXT NOT NULL  -- 'finalize' | 'consolidate'
  workflowRunId TEXT NOT NULL FK → workflowRuns.id
  parallelGroupId TEXT  -- for consolidate
  phase TEXT NOT NULL  -- 'commit' | 'rebase' | 'merge' | 'cleanup' | 'done'
  metadata TEXT  -- JSON: { targetBranch, mergedChildren: [], conflictChild, ... }
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(workflowRunId, type)  -- one active operation per workflow
```

### 4.3 Status Enums

```typescript
// Workflow run lifecycle (driven by use workflow)
type WorkflowRunStatus = 'pending' | 'provisioning' | 'running' | 'stage_failed'
  | 'awaiting_review' | 'awaiting_proposals' | 'waiting_for_children'
  | 'children_completed_with_failures'  // some children done, user must decide
  | 'awaiting_conflict_resolution' | 'finalizing'
  | 'completed' | 'failed' | 'cancelled'

// Stage execution lifecycle (per stage within a run)
type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

// Review lifecycle
type ReviewType = 'stage' | 'consolidation'
type ReviewStatus = 'pending_review' | 'approved' | 'changes_requested'

// Parallel group lifecycle
type ParallelGroupStatus = 'pending' | 'running'
  | 'children_completed'      // all done, ready for consolidation
  | 'children_mixed'          // some failed — user decision needed
  | 'consolidating'
  | 'completed' | 'failed' | 'cancelled'

// Proposal lifecycle
type ProposalStatus = 'proposed' | 'approved' | 'launched' | 'discarded'
```

---

## 5. Workflow Orchestration Architecture

### 5.1 Separation of Concerns

```
┌─────────────────────────────────────────────────┐
│  use workflow  (Durable Orchestration Layer)     │
│                                                  │
│  Responsibilities:                               │
│  • Stage sequencing (which stage runs next)      │
│  • Human suspension (review gates, proposal gates)│
│  • Parallel fan-out/fan-in                       │
│  • Retry/replay of completed steps               │
│  • Durability at suspension points               │
│                                                  │
│  Does NOT:                                       │
│  • Manage Docker processes directly              │
│  • Parse ACP streams                             │
│  • Manage WebSocket connections                  │
│  • Handle high-frequency streaming events        │
└────────────────────┬────────────────────────────┘
                     │ calls "use step" functions
                     ▼
┌─────────────────────────────────────────────────┐
│  Services  (Execution + Business Logic Layer)   │
│                                                  │
│  • session-manager: ACP session lifecycle        │
│  • sandbox: Docker sandbox per workflow run       │
│  • worktree: git worktree per workflow run        │
│  • acp-client: NDJSON stdio communication        │
│  • review-service: diff + summary + plan         │
│  • credential-vault: encrypt/decrypt/inject      │
│  • proposal-service: CRUD + parsing              │
│  • branch-namer: LLM name + sanitize + dedup     │
└─────────────────────────────────────────────────┘
```

**Why two layers instead of three:** There is no separate "task runtime" because stages are not independent execution units — they are phases within a single, continuous agent conversation sharing one sandbox and one worktree. The workflow step directly calls service functions to manage the ACP session (send prompt, await completion, stream output). This eliminates the indirection of creating a "task" entity and polling for its completion.

**Service dependency DAG (no circular dependencies):**
```
session-manager → sandbox, worktree, acp-client, credential-vault
review-service  → worktree (for diffs), branch-namer
proposal-service → (standalone, reads DB only)
branch-namer    → (standalone, calls LLM)
credential-vault → (standalone, reads DB + encryption)
sandbox         → (standalone, shells out to Docker)
worktree        → (standalone, shells out to git)
acp-client      → (standalone, manages stdio streams)
streaming-service → acp-client (reads events)
```
Services form a strict DAG. No service depends on session-manager or the workflow layer. Workflow steps are the only callers of session-manager.

### 5.2 Workflow Invocation

The bridge between HTTP API and durable workflow runtime:

```
POST /api/runs  (route handler in routes/runs.ts)
  │
  │  1. Validate inputs (project, template, agent capabilities)
  │  2. Create workflowRun record in SQLite (status: 'pending')
  │  3. Call: await start(runWorkflowPipeline, [{ runId, ... }])
  │     │
  │     │  start() is imported from 'workflow/api'
  │     │  It enqueues the workflow function for execution by the
  │     │  use workflow runtime (via Nitro's queue handler at
  │     │  /.well-known/workflow/v1/flow)
  │     │
  │     └──▶ Returns immediately (fire-and-forget)
  │
  │  4. Return { runId, status: 'pending' } to GUI
  │
  └──▶ GUI subscribes to WS for run updates
```

The `start()` function from `workflow/api` is the entry point. It:
- Serializes the workflow function reference + arguments
- Enqueues a workflow invocation message
- The Nitro queue handler (`/.well-known/workflow/v1/flow`) picks it up and executes `runWorkflowPipeline()`
- The workflow function runs asynchronously — the route handler does NOT await it

For hook resumption, `resumeHook()` from `workflow/api` similarly enqueues re-execution:
```
POST /api/reviews/:id/approve  (route handler)
  │
  │  1. Write hookResumes outbox entry
  │  2. Update review status in SQLite
  │  3. Call: await resumeHook(token, { action: 'approve' })
  │     └──▶ Re-enqueues the suspended workflow for execution
  │  4. Delete hookResumes entry on success
  │
  └──▶ Workflow resumes from hook point asynchronously
```

### 5.3 Stage Execution Model

The workflow step `execute-stage.ts` directly manages the ACP session within the shared sandbox:

```
Workflow step (execute-stage.ts):
  1. Check if stageExecution already exists for (runId, stageName, round)
     → If yes and completed: return cached result (idempotent replay)
     → If yes and running: skip to step 4 (resume monitoring)
     → If yes and failed: return failure
  2. Create stageExecution record in SQLite (status: pending)
  3. Determine session mode:
     - First stage of run: call sessionManager.create(runId)
       → provisions sandbox, creates worktree, starts ACP session
     - Continuation (freshSession=false): call sessionManager.continue(runId)
       → sends prompt into existing ACP session via --continue
     - Fresh session (freshSession=true): call sessionManager.fresh(runId, context)
       → starts new ACP session in same sandbox/worktree
       → injects context: prior assistant messages + plan.md + review summary
  4. Build stage prompt via buildStagePrompt():
     - Run description + stage template instructions
     - For request_changes rounds: append bundled review comments
  5. Send prompt into ACP session (via stdin)
  6. Update stageExecution.status = 'running'
  7. Stream output events → WebSocket → GUI
  8. Await agent completion (ACP 'result' event or exit)
  9. Update stageExecution: status = 'completed' or 'failed'
  10. Store usage stats, last assistant message
  11. Return stage result to workflow orchestrator
```

This model means:
- No separate "task" entity — the stageExecution record tracks per-stage state
- The sandbox and ACP session are owned by the workflow run, not by a stage
- Stage transitions are seamless: the agent doesn't know stages changed (unless freshSession)
- **Steps are replay-safe**: check-before-act prevents duplicate prompts or sandboxes

### 5.3 Hook Architecture

Three types of hooks suspend workflows for human input:

#### 5.3.1 Review Decision Hook

```
1. Agent completes within a stage (reviewRequired: true)
   → create-review step generates diff, creates review record
   → Workflow updates workflowRun.status = 'awaiting_review'
   → Workflow reaches hook: await reviewDecisionHook.create({ token: `review:${reviewId}` })
   → Workflow suspends. Hook state persisted to .workflow-data/

2. User clicks "Approve" in GUI
   → GUI sends POST /api/reviews/{id}/approve

3. Daemon route handler (atomic operation):
   a. INSERT INTO hookResumes (hookToken, action, createdAt)
   b. UPDATE reviews SET status = 'approved'
   c. Call resumeHook(`review:${reviewId}`, { action: 'approve' })
   d. On success: DELETE FROM hookResumes WHERE hookToken = ...
   e. On failure: pending resume stays in table for startup reconciler

4. Workflow resumes from the hook point, receiving { action: 'approve' }

5. Startup reconciler (on daemon restart):
   SELECT * FROM hookResumes
   For each: retry resumeHook() — ensures no stuck workflows
```

**Actions:** `{ action: 'approve' }` or `{ action: 'request_changes', comments: ReviewComment[] }`

For request_changes: the workflow's inject-comments step bundles comments as markdown and sends them into the existing ACP conversation as a user message. The agent continues in the same session — no new process or sandbox. The stageExecution round increments.

#### 5.3.2 Stage Failed Hook

When the agent fails mid-stage, the execute-stage step detects failure and the workflow creates a failure hook:

```
1. execute-stage step returns { status: 'failed', error }
2. Workflow updates workflowRun.status = 'stage_failed'
3. Workflow reaches hook: await stageFailedHook.create({ token: `failed:${runId}:${stageName}` })
   → Workflow suspends

4. User decides via GUI:
   POST /api/runs/{id}/retry-stage   → resumes with { action: 'retry' }
   POST /api/runs/{id}/skip-stage    → resumes with { action: 'skip' }
   POST /api/runs/{id}/cancel        → resumes with { action: 'cancel' }

5. Workflow resumes:
   - retry: send failure-aware message into the conversation:
     "The previous attempt failed with: {error}. Please retry: {stage prompt}"
     Agent continues in the same session (round increments)
   - skip: advance to next stage (previousResult = null)
   - cancel: workflow moves to 'cancelled' state
```

#### 5.3.3 Proposal Review Hook

```
1. Split stage completes → proposals extracted and stored in SQLite
2. Workflow updates workflowRun.status = 'awaiting_proposals'
3. Workflow reaches hook: await proposalReviewHook.create({ token: `proposals:${runId}` })
   → Workflow suspends

4. User reviews/edits proposals in GUI, clicks "Launch Selected"
   POST /api/proposals/launch → resumes with { proposalIds: [...] }

5. Workflow resumes, launches child workflows
```

#### 5.3.4 Parallel Completion Hook

When all children reach a terminal state (completed, failed, or cancelled):

```
1. Workflow detects all children done (via Promise.all settling or polling)
   → If any children failed/cancelled:
     workflow updates workflowRun.status = 'children_completed_with_failures'
     → Workflow reaches hook: await parallelCompletionHook.create({ token: `parallel:${runId}` })
     → Suspends. User sees summary: N completed, M failed, K cancelled
   → If all children completed:
     proceed directly to consolidation

2. User decides via GUI (for mixed results):
   POST /api/parallel-groups/{groupId}/consolidate-partial  → resumes with { action: 'consolidate_completed' }
   POST /api/parallel-groups/{groupId}/retry-children       → resumes with { childRunIds: [...] }
   POST /api/parallel-groups/{groupId}/cancel               → resumes with { action: 'cancel' }

3. For retry: failed children are restarted. Hook re-suspends until all done again.
   For consolidate_completed: only completed children proceed to consolidation.
```

#### 5.3.5 Consolidation Review Hook

After successful branch consolidation, the combined result is reviewed before merging to parent:

```
1. consolidate step merges completed child branches (in sortOrder) into consolidation branch
2. create-review step generates combined diff (merge-base to consolidation HEAD)
   → Creates review record (type: 'consolidation')
   → Workflow updates workflowRun.status = 'awaiting_review'
3. Workflow reaches hook: await reviewDecisionHook.create({ token: `review:${reviewId}` })
   → Suspends (same hook type as standard reviews)

4. User reviews combined diff in GUI → approves or requests changes
   - Approve: parent worktree fast-forwarded to consolidation branch.
     Post-split stages use freshSession=true with consolidation summary as context.
   - Request changes: currently not supported for consolidation reviews
     (user should fix via child reruns). Cancel and re-split if needed.
```

#### 5.3.6 Conflict Resolution Hook

Used during finalization (rebase conflict) and consolidation (merge conflict):

```
1. Finalize step: git rebase fails with conflict
   → Step creates conflictResolution record in SQLite
   → Workflow reaches hook: await conflictHook.create({ token: `conflict:${runId}` })
   → Workflow suspends, workflowRun.status = 'awaiting_conflict_resolution'

2. User resolves conflict externally (in their editor/terminal)
   POST /api/runs/{id}/resolve-conflict → resumes with { action: 'retry' }
   POST /api/runs/{id}/cancel           → resumes with { action: 'cancel' }

3. Workflow resumes:
   - retry: re-attempt rebase/merge (user should have resolved conflicts)
   - cancel: workflow fails with 'merge_conflict' reason
```

### 5.4 ACP Session Continuity

The `session-manager` service manages the ACP session lifecycle across stages within a workflow run. One sandbox, one worktree, and (by default) one continuous conversation:

**Session command serialization:** All operations that write to ACP stdin (send prompt, send intervention, send review comments, stop) are serialized through a per-run mutex in the session-manager. This prevents races between stage transitions, user interventions, and cancellation:

```typescript
class SessionManager {
  private sessionLocks = new Map<string, Mutex>();  // runId → Mutex

  async withSession<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.sessionLocks.get(runId) ?? new Mutex();
    this.sessionLocks.set(runId, mutex);
    return mutex.runExclusive(fn);
  }
}
// All stdin writes go through: sessionManager.withSession(runId, () => acpClient.send(...))
```

```
Stage 1 (first stage):
  1. sessionManager.create(runId):
     a. Provisions Docker sandbox (vibe-<shortId>)
     b. Creates git worktree with LLM-generated branch name
     c. Starts ACP: copilot --acp --stdio --yolo --autopilot
     d. Receives session initialization → stores acpSessionId on workflowRun
  2. Stage prompt sent into conversation
  3. Agent executes, completes
  4. Sandbox stays alive (ACP session still running in container)

Stage 2 (continuation, freshSession=false):
  1. sessionManager.continue(runId):
     a. Reuses same sandbox (already running)
     b. Sends new prompt via ACP stdin (--continue semantics)
     c. Agent resumes with full context from all prior stages
  2. Agent executes, completes

Stage 3 (freshSession=true):
  1. sessionManager.fresh(runId, context):
     a. Same sandbox + worktree (no new container)
     b. Sends ACP session reset command
     c. Starts new ACP session within same container
     d. Injects context into fresh prompt:
        - Agent's final assistant message from each completed stage
        - plan.md content (if captured from sandbox filesystem)
        - Latest approved review summary
     e. New acpSessionId stored on workflowRun
  2. Agent executes with injected context (not conversational memory)
  3. Session log retains ALL prior messages with a session boundary marker

Request-changes (same stage, next round):
  1. Review comments bundled as markdown user message
  2. sessionManager.continue(runId): sends comments into existing session
  3. Agent continues in the same conversation — remembers everything
  4. Round number increments on stageExecution

Cancellation:
  1. sessionManager.stop(runId):
     a. Sends ACP stop command to agent (graceful shutdown)
     b. Waits up to 30s for agent to finish
     c. If timeout: force-kills sandbox process
     d. Worktree state preserved as-is (no final diff)
     e. Marks workflow cancelled

Split child workflows:
  1. Each child gets its own sandbox + worktree (branched off parent's worktree)
  2. Fresh ACP session (independent from parent conversation)
  3. Child's prompt: proposal description (NOT a --continue from parent)
  4. Post-split stages in parent use freshSession=true with consolidation summary
```

**Session log integrity (FR-W19):** The `runMessages` table captures the complete agent session log — all tool calls, reasoning, assistant messages, interventions, system messages, and usage stats. A `freshSession` stage inserts a `sessionBoundary` marker but does NOT delete prior messages. The log is append-only within a workflow run.

### 5.5 Git Operations Safety

Git write operations (worktree create/merge/rebase) are protected by a per-repository mutex and a durable operations journal.

#### 5.5.1 Per-Repository Mutex

```typescript
// services/worktree.ts
class WorktreeService {
  private repoLocks = new Map<string, Mutex>();  // projectPath → Mutex

  async withRepoLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.repoLocks.get(projectPath) ?? new Mutex();
    this.repoLocks.set(projectPath, mutex);
    return mutex.runExclusive(fn);
  }
}
```

All git write operations (worktree add/remove, merge, rebase, commit) acquire the repo lock first. Read operations (diff, branch list) do not require the lock.

#### 5.5.2 Worktree Lifecycle (per Workflow Run)

```
Workflow run start:
  1. branch-namer generates branch from run description (LLM-based)
     → sanitized to valid git ref format: [a-zA-Z0-9._/-]
     → deduplicated with numeric suffix if branch already exists
     → fallback: vibe-harness/run-<shortId>
  2. git worktree add <project>/.vibe-harness-worktrees/<branch>/ -b <branch> <baseBranch>
  3. worktreePath + branch stored on workflowRun record

Split child start:
  1. **Snapshot parent state:** commit all uncommitted changes in parent worktree
     (auto-generated message: "Snapshot before split: {stage name}")
     This ensures child branches include all parent's work-in-progress
  2. branch-namer generates branch from proposal title
     → fallback: vibe-harness/split-<shortId>
  3. git worktree add ... -b <childBranch> <parentWorktreeHEAD>
     (branched off PARENT's worktree HEAD commit, not repository HEAD)

Final approval (last stage):
  — Detected by: current stage index === template.stages.length - 1
     OR stage has explicit `isFinal: true` flag in template
  1. commit all uncommitted changes in worktree
  2. rebase worktree branch onto targetBranch
  3. if conflict: abort rebase, suspend for user resolution
  4. fast-forward merge into targetBranch
  5. cleanup: git worktree remove, delete branch

Cancellation/failure:
  Worktree preserved for user inspection. Cleaned up via GUI or retention policy.
```

#### 5.5.3 Durable Git Operations Journal

Multi-step git operations (finalize, consolidate) use a journal table to track progress and enable safe resume after crash:

```
gitOperations
  id TEXT PK
  type TEXT NOT NULL  -- 'finalize' | 'consolidate'
  workflowRunId TEXT NOT NULL FK → workflowRuns.id
  parallelGroupId TEXT  -- for consolidate
  phase TEXT NOT NULL  -- 'commit' | 'rebase' | 'merge' | 'cleanup' | 'done'
  metadata TEXT  -- JSON: { targetBranch, mergedChildren: [], conflictChild, ... }
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(workflowRunId, type)  -- one active operation per workflow
```

**Finalize phases:** `commit → rebase → merge → cleanup → done`
**Consolidate phases:** `snapshot_parent → merge_children → ff_parent → cleanup → done`

**Important: Consolidation does NOT merge to target branch.** It only:
1. `snapshot_parent`: commit parent worktree state before merge
2. `merge_children`: merge child branches into a consolidation branch (in `proposals.sortOrder`, per FR-S9)
3. `ff_parent`: fast-forward parent worktree to consolidation branch HEAD
4. `cleanup`: remove child worktrees/branches

After consolidation + review approval, the **parent workflow continues** with subsequent stages on the updated worktree. The final `merge → targetBranch` happens in the **finalize** operation at the very end of the workflow (last stage approval → FR-R10).

During `merge_children` phase, the `metadata` JSON tracks `{ mergeOrder: [childRunId...], mergedChildren: [], conflictChild, consolidationBranch }`.

On replay/restart, the step reads the journal and resumes from the last completed phase. Each phase is idempotent:
- `commit`/`snapshot_parent`: checks if HEAD has uncommitted changes before committing
- `rebase`: checks if branch is already rebased onto target
- `merge`/`merge_children`: checks if child branch is already merged into consolidation branch
- `ff_parent`: checks if parent HEAD already matches consolidation HEAD
- `cleanup`: checks if worktree/branch still exists before removing

---

## 6. Security Architecture

### 6.1 Authentication

```
~/.vibe-harness/
├── auth.token          # 256-bit random token, generated on first daemon start
├── encryption.key      # AES-256 key for credential encryption (fallback)
├── daemon.pid          # PID of running daemon
└── daemon.port         # Port number daemon is listening on
```

- All files created with 0600 permissions (owner read/write only)
- Auth token sent as `Authorization: Bearer <token>` on every HTTP request
- WebSocket upgrade request must include auth token as query param or header
- macOS: encryption key stored in Keychain (preferred). Linux: libsecret. Fallback: file.

### 6.2 Sandbox Isolation

- Docker sandboxes mount ONLY the project worktree directory (read-write)
- No host filesystem access beyond the worktree
- Network: `docker sandbox network proxy` with localhost allowlist only
- Credentials injected via stdin pipe (env vars via `-e`, files via `tee`, logins via `docker login --password-stdin`) — never mounted as files from host
- Sandbox name: `vibe-<shortId>` derived from workflow run ID

---

## 7. Deployment & Distribution Architecture

### 7.1 Build Pipeline

```
Source:
  v2/daemon/ + v2/gui/ + v2/shared/

Daemon build:
  1. npm install (workspaces)
  2. workflow build (compiles "use workflow"/"use step" → .well-known/)
  3. nitro build (or tsc + esbuild for non-Nitro path)
  → Output: daemon bundle (Node.js executable)

GUI build:
  1. vite build (React frontend → dist/)
  2. cargo tauri build (Rust shell + embed frontend + bundle daemon sidecar)
  → Output: .dmg (macOS), .AppImage (Linux)

Phase 7 stretch: bun build --compile or Node.js SEA → single binary daemon
```

### 7.2 Directory Layout on User Machine

```
~/.vibe-harness/
├── auth.token
├── encryption.key (fallback)
├── daemon.pid
├── daemon.port
├── vibe-harness.db          # SQLite database
├── vibe-harness.db-wal      # WAL journal
├── .workflow-data/           # use workflow event log
│   ├── runs/
│   ├── steps/
│   ├── hooks/
│   └── events/
└── logs/
    └── daemon.log           # Structured JSON log (rotated)
```

---

## 8. API Design

### 8.1 Endpoint Summary

See SRD §2 for functional requirements. Full API spec will be in CDD.md.

| Group | Endpoints | Key Operations |
|-------|-----------|----------------|
| Projects | 5 | CRUD + list branches |
| Runs | 11 | CRUD + start/cancel/stop/message/diff/stream + retry/skip/resolve |
| Workflows | 5 | Template CRUD |
| Reviews | 5 | Get + approve/request-changes + comments CRUD |
| Proposals | 5 | CRUD + launch |
| Parallel Groups | 5 | Status + consolidate + consolidate-partial + retry-children + cancel |
| Credentials | 6 | Set CRUD + entry CRUD + audit |
| Agents | 4 | CRUD |
| Stats | 1 | Workspace summary |
| Health | 1 | Daemon health check |
| WebSocket | 1 | /ws — streaming + notifications |

### 8.2 Key Endpoint Patterns

```
Runs:
  GET    /api/runs                    List runs (filterable by status, project)
  POST   /api/runs                    Create + start a workflow run
  GET    /api/runs/:id                Get run details (stages, current state)
  DELETE /api/runs/:id                Delete a run (must be terminal)
  PATCH  /api/runs/:id/cancel         Cancel a running workflow (ACP stop)
  POST   /api/runs/:id/message        Send intervention message to running agent
  GET    /api/runs/:id/diff           Get current diff for the run's worktree
  GET    /api/runs/:id/messages       Get conversation history
  POST   /api/runs/:id/retry-stage    Retry a failed stage
  POST   /api/runs/:id/skip-stage     Skip a failed stage
  POST   /api/runs/:id/resolve-conflict  Resume after conflict resolution

Reviews:
  GET    /api/reviews?runId=X&stageName=Y  List reviews for a run/stage (supports round navigation)
  GET    /api/reviews/:id             Get review (diff + summary + plan)
  POST   /api/reviews/:id/approve     Approve review → advance workflow
  POST   /api/reviews/:id/request-changes  Request changes → inject comments
  POST   /api/reviews/:id/comments    Add comment to review
  GET    /api/reviews/:id/comments    Get comments for review

Parallel Groups:
  GET    /api/parallel-groups/:id     Get group status (children summary)
  POST   /api/parallel-groups/:id/consolidate         Consolidate all completed children
  POST   /api/parallel-groups/:id/consolidate-partial  Consolidate completed only (skip failed)
  POST   /api/parallel-groups/:id/retry-children       Retry failed children
  POST   /api/parallel-groups/:id/cancel               Cancel group + all children

Workflows (templates):
  GET    /api/workflows               List templates
  POST   /api/workflows               Create template
  GET    /api/workflows/:id           Get template details
  PUT    /api/workflows/:id           Update template
  DELETE /api/workflows/:id           Delete template
```

### 8.3 API Versioning

No versioning for MVP. All endpoints under `/api/`. If breaking changes needed later, introduce `/api/v2/`.

---

## 9. Technology Rationale

| Decision | Alternatives Considered | Why This Choice |
|----------|------------------------|-----------------|
| **Hono** over Fastify/Express | Express (heavy, legacy), Fastify (mature but heavier) | Hono: lightweight, Web Standard APIs, official `use workflow` Hono guide, works with Node.js and Bun |
| **Nitro** as build system | Custom SWC pipeline, esbuild-only | Nitro is required by `use workflow` for directive compilation. Official support path |
| **Drizzle** over Prisma/TypeORM | Prisma (heavy, engine binary), TypeORM (older) | Drizzle: lightweight, type-safe, familiar from v1, great SQLite support |
| **Zustand** for GUI state | Redux, Jotai, MobX | Zustand: minimal boilerplate, works well with WebSocket-driven updates, tiny bundle |
| **Streamdown** for markdown | react-markdown, marked | Streamdown: specifically designed for streaming AI output, handles incomplete syntax |
| **Local World** over Postgres | Postgres World (production-grade) | Local World: zero dependencies, file-based, spike proved durability at hook points. Postgres overkill for single-user local daemon |
| **Pino** for logging | Winston, console.log | Pino: fast structured JSON logging, low overhead, standard in Node.js ecosystem |

---

## 10. Cross-Cutting Concerns

### 10.1 Input Validation (NFR-S5)

All user-supplied inputs that reach shell commands or git operations pass through `lib/validation.ts`:

- **Git refs** (branch names, tags): validated against allowlist pattern `^[a-zA-Z0-9._/-]+$`. Blocks backticks, `$`, `;`, `|`, `<>`, `()`, `{}`, `\`, newlines, `..`
- **File paths**: normalized and validated to be within project directory (no path traversal)
- **Prompt text**: sanitized before injection into shell env vars (no command injection via prompt)

Validation runs at the **service layer** (before any shell-out), not at the route layer. This ensures all callers (routes, workflow steps) are protected.

### 10.2 Error Handling Strategy

- **Services** throw typed errors (e.g., `RunNotFoundError`, `StageNotRunningError`, `WorkflowNotRunningError`)
- **Routes** catch and map to HTTP status codes + standard error JSON
- **Workflow steps** catch and let `use workflow` handle retries (up to 3 by default)
- **Fatal errors** (e.g., corrupt DB) throw `FatalError` to skip retries
- **Stage failures** are caught by the execute-stage step and surfaced as a stage_failed hook — user can retry, skip, or cancel (FR-W14)
- **GUI** displays error toasts for API failures, inline errors for form validation

### 10.3 Logging

- **Daemon:** Pino structured JSON → `~/.vibe-harness/logs/daemon.log` (rotated)
- **Levels:** error, warn, info, debug
- **Context:** every log entry includes `{ workflowRunId?, stageName?, operation }`
- **Sensitive data:** credential values NEVER logged. Tokens masked.

### 10.4 Testing Strategy

| Layer | Test Type | Tools |
|-------|-----------|-------|
| Services (session-manager, sandbox, worktree, diff parser, etc.) | Unit + Integration | Vitest |
| Workflow steps (execute-stage, create-review, etc.) | Integration (mock services) | Vitest |
| API routes | Integration (supertest-like) | Vitest + Hono test client |
| Workflow durability | E2E (start, kill, restart, resume) | Custom test script |
| GUI components | Component tests | Vitest + React Testing Library |
| Full system | E2E (GUI → daemon → sandbox) | Playwright (Tauri) or manual |

### 10.5 Data Retention & Cleanup (NFR-R7)

Daemon runs a cleanup sweep on startup and daily (if running continuously):

- **Workflow state files** (`.workflow-data/`): runs older than 30 days (configurable) are deleted
- **Run messages in DB** (`runMessages`): conversation logs are **never truncated or deleted** while the workflow run exists (FR-W19). When a workflow run is deleted (manually or by retention), its messages are cascade-deleted with it
- **Workflow run records**: runs in terminal state (completed/failed/cancelled) older than 90 days are eligible for archival or deletion (configurable). User can pin runs to prevent deletion
- **Orphaned worktrees**: worktrees with no matching active workflow run, older than 7 days, are flagged in logs. User can delete via GUI or API
- **Orphaned Docker sandboxes**: stopped on startup reconciliation (§2.1.3)
- **Log rotation**: `daemon.log` rotated at 10MB, max 5 files

### 10.6 Seed Data (FR-A3, FR-W11)

On first database initialization (no existing data), daemon seeds:

- **Default Copilot CLI agent definition** (FR-A3): name "Copilot CLI", type "copilot_cli", commandTemplate "copilot", dockerImage "vibe-harness/copilot:latest"
- **Pre-built workflow templates** (FR-W11): "Quick Run" (single auto-advance stage), "Plan & Implement" (2-stage: plan → implement → commit), "Full Review" (5-stage: plan → implement → review → fix → commit)

Seeding is idempotent (checks for existing records before inserting).

### 10.7 Prerequisite Checks (NFR-I4)

Daemon exposes `GET /api/prerequisites` which checks:

1. Docker installed: `docker --version`
2. Docker running: `docker info`
3. Docker sandbox available: `docker sandbox --help`
4. Git installed: `git --version`
5. GitHub auth: `gh auth token` or `GITHUB_TOKEN` env var
6. Sandbox image present: `docker images vibe-harness/copilot:latest`

Returns structured result per check: `{ name, status: 'ok' | 'missing' | 'error', message, fixInstructions }`.

GUI calls this on startup and displays `PrerequisiteCheck.tsx` if any check fails.

### 10.8 Agent Capability Validation (FR-A5)

Before starting a workflow run, the daemon checks agent capabilities:
- Multi-stage with `freshSession=false`: agent must have `supportsContinue=true`
- Intervention required: agent must have `supportsIntervention=true`
- Streaming output: agent must have `supportsStreaming=true`

Validation fails fast with clear error before provisioning any resources.

---

## 11. Traceability to SRD

| SRD Requirement | SAD Section |
|-------------|-------------|
| §2.1 Project Management (FR-P1–P7) | §4.2 Schema (projects), §8.1 Projects endpoint |
| §2.2 Agent Definitions (FR-A1–A5) | §4.2 Schema (agentDefinitions), §10.8 Capability Validation |
| §2.3 Conceptual Model | §1.3 Principles, §5.1 Separation of Concerns, §5.2 Stage Execution Model |
| §2.4 Workflow Orchestration (FR-W1–W22) | §5 Workflow Architecture, §4.1 Persistence, §5.3 Hooks, §5.4 Session Continuity |
| §2.5 Split Execution (FR-S1–S13) | §5.4.4 Parallel Completion Hook, §5.4.5 Consolidation Review Hook, §5.5.2 Worktree Lifecycle, §5.5.3 Git Journal |
| §2.6 Human Review (FR-R1–R11) | §5.3.1 Review Hook, §5.3.4 Conflict Hook, §3.1–3.2 REST+WS |
| §2.7 Credentials (FR-C1–C8) | §6 Security Architecture, §4.2 Schema (credentials) |
| §2.8 Dashboard (FR-D1–D3) | §8.1 Stats endpoint |
| §3.1 Installation (NFR-I1–I5) | §7 Deployment, §10.7 Prerequisites |
| §3.2 Performance (NFR-P1–P4) | §2.2.4 Streaming, §4.1 WAL mode |
| §3.3 Reliability (NFR-R1–R7) | §2.1.3 Reconciliation, §4.1 Consistency, §5.5.3 Git Journal, §10.5 Retention |
| §3.4 Security (NFR-S1–S7) | §6 Security Architecture, §10.1 Input Validation |
| §3.5 UX (NFR-U1–U8) | §2.2.2 Multi-Window, §2.2.3 Sidecar, §2.2.4 Streaming |
| §3.6 Observability (NFR-O1–O3) | §10.3 Logging, §8.1 Health endpoint |
