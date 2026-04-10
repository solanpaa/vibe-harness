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
│    Tauri  │ sidecar           │  │  Task Runtime          │  │   │
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
│  │  │ Task 1   │  │ Task 2   │  │ Task N   │               │   │
│  │  │ Copilot  │  │ Copilot  │  │ Copilot  │               │   │
│  │  │ CLI      │  │ CLI      │  │ CLI      │               │   │
│  │  └──────────┘  └──────────┘  └──────────┘               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Git Repositories (user's local repos)                    │   │
│  │  ├── project-a/                                           │   │
│  │  │   └── .vibe-harness-worktrees/                        │   │
│  │  │       ├── task-abc123/  (isolated worktree)            │   │
│  │  │       └── split-def456/ (split child worktree)         │   │
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
| **Git Worktrees** | Branch isolation per task/split child | `git worktree add/remove` |

### 1.3 Key Architectural Principles

1. **Daemon is the single source of truth.** All state lives in the daemon (SQLite + workflow event log). GUI and CLI are stateless presentation layers.
2. **Workflow orchestration and task execution are separate concerns.** `use workflow` drives stage progression; task runtime manages subprocess lifecycle. They communicate via events, not direct coupling.
3. **All mutations go through the daemon API.** No direct DB access from GUI. No state mutations in the client.
4. **Streaming is push-based.** Agent output flows: Docker stdio → daemon ACP client → WebSocket → GUI. GUI subscribes, daemon pushes.
5. **Idempotent commands.** All mutating API operations are safe to retry.

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
│   │   ├── tasks.ts             # /api/tasks/*
│   │   ├── projects.ts          # /api/projects/*
│   │   ├── workflows.ts         # /api/workflows/*
│   │   ├── reviews.ts           # /api/reviews/*
│   │   ├── proposals.ts         # /api/proposals/*
│   │   ├── credentials.ts       # /api/credentials/*
│   │   ├── agents.ts            # /api/agents/*
│   │   └── stats.ts             # /api/stats
│   │
│   ├── ws/                      # WebSocket handlers
│   │   └── task-stream.ts       # Per-task streaming: agent output + status events
│   │
│   ├── workflows/               # use workflow definitions
│   │   ├── pipeline.ts          # Main: runWorkflowPipeline()
│   │   ├── hooks.ts             # defineHook() for review/proposal/merge gates
│   │   └── steps/               # "use step" implementations
│   │       ├── execute-stage.ts # Launch task, await completion
│   │       ├── create-review.ts # Generate diff, create review record
│   │       ├── rerun-stage.ts   # Bundle comments, create rerun task
│   │       ├── extract-proposals.ts # Parse split agent output
│   │       ├── launch-children.ts   # Create parallel group + child workflows
│   │       ├── consolidate.ts       # Merge child branches
│   │       └── finalize.ts          # Final commit/rebase/merge
│   │
│   ├── services/                # Core business logic (framework-agnostic)
│   │   ├── task-manager.ts      # Task lifecycle: create, start, monitor, complete
│   │   ├── sandbox.ts           # Docker sandbox: create, exec, stop, list
│   │   ├── worktree.ts          # Git worktree: create, diff, merge, cleanup
│   │   ├── acp-client.ts        # ACP protocol: NDJSON over stdio
│   │   ├── review-service.ts    # Diff generation, AI summary, plan capture
│   │   ├── credential-vault.ts  # Encrypt/decrypt, inject into sandbox
│   │   ├── proposal-service.ts  # CRUD for split proposals
│   │   ├── diff-parser.ts       # Unified diff → structured DiffFile[]
│   │   └── title-generator.ts   # Auto-generate titles from prompts
│   │
│   ├── state/                   # Task state machine
│   │   └── task-machine.ts      # Allowed transitions + callbacks
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
│       └── reconcile.ts         # Startup: sandbox/task reconciliation
```

#### 2.1.2 Daemon Lifecycle

```
Start:
  1. Read/create config directory (~/.vibe-harness/)
  2. Generate auth token if first run
  3. Initialize SQLite + run migrations
  4. Reconcile orphaned sandboxes/tasks (NFR-R3)
  5. Pick available port, write to daemon.port file
  6. Write PID to daemon.pid file
  7. Start Hono HTTP server on localhost:<port>
  8. Start Unix socket listener at daemon.sock (post-MVP)
  9. Log "daemon ready" with port

Shutdown (SIGTERM/SIGINT):
  1. Stop accepting new connections
  2. Close all WebSocket connections
  3. Stop all running tasks (best-effort sandbox cleanup)
  4. Close database connection
  5. Remove daemon.port and daemon.pid files

Single-instance:
  On start, check daemon.pid — if another daemon is running, exit with error.
```

#### 2.1.3 Startup Reconciliation (NFR-R3)

```
On daemon start:
  1. docker sandbox ls --filter name=vibe-* → list of live sandboxes
  2. SELECT * FROM tasks WHERE status IN ('running', 'provisioning')
  3. For each running/provisioning task:
     - If matching sandbox exists: mark task failed (reason: "daemon_restart")
       AND stop the sandbox (agent has lost its connection)
     - If no sandbox: mark task failed (reason: "daemon_restart")
  4. For each live sandbox with no matching task: stop sandbox (orphan)
  5. Workflow hooks at suspension points remain intact (.workflow-data/)
  6. Log reconciliation summary
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
│   │   ├── workspace.ts         # Task list, selected item, filters
│   │   ├── streaming.ts         # Per-task streaming output buffer
│   │   └── daemon.ts            # Connection status, health
│   │
│   ├── pages/
│   │   ├── Workspace.tsx        # Main: task feed + detail panel
│   │   ├── Projects.tsx         # Project CRUD
│   │   ├── Workflows.tsx        # Template editor + run list
│   │   ├── Credentials.tsx      # Vault management
│   │   └── Settings.tsx         # Agent definitions, preferences
│   │
│   ├── components/
│   │   ├── task/
│   │   │   ├── TaskFeed.tsx           # Filterable task/workflow list
│   │   │   ├── TaskDetail.tsx         # Full task view: prompt + output + actions
│   │   │   ├── TaskOutput.tsx         # Streamdown-rendered streaming output
│   │   │   ├── TaskConversation.tsx   # Message history (user/assistant turns)
│   │   │   └── NewTaskModal.tsx       # Task creation form
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
│   │       ├── StatusBadge.tsx         # Task/workflow/review status
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
- **Main window** — Workspace: task feed + detail panel (always open)
- **Detached detail windows** — Task detail, Review panel, or Workflow view popped out into separate OS windows

**Architecture:**
```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  Main Window          │   │  Detached Window 1    │   │  Detached Window 2    │
│  (Workspace)          │   │  (Task Detail #42)    │   │  (Review #17)         │
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
- User right-clicks task → "Open in New Window" → Tauri creates `new WebviewWindow({ url: '/task/42' })`
- New window bootstraps: read auth token, connect WS, fetch task data, subscribe to task stream
- Main window's task feed continues to show status updates for all tasks (including detached ones)
- Closing a detached window has no effect on the task/workflow — daemon keeps running

**Broadcast:**
- Global notifications (workflow_status, review_created) are broadcast to ALL connected WS clients
- Task-specific output events go only to windows subscribed to that taskId
- This means multiple windows viewing the same task all get the same stream

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

#### 2.2.3 Streaming Architecture

```
Agent output flow:
  Docker sandbox stdout
    → ACP client (NDJSON parsing, event extraction)
    → StreamingService (per-task event buffer with sequence numbers)
    → WebSocket (push to all connected clients)
    → Zustand streaming store (append to buffer)
    → TaskOutput component (Streamdown renders markdown)

Reconnection:
  GUI sends last-seen sequence number on WS reconnect.
  Daemon replays events from that point forward.
  Buffer is bounded (configurable, default 10,000 events per task).
```

### 2.3 Shared Types Package

```
shared/
├── package.json
├── types/
│   ├── entities.ts      # Project, Task, WorkflowRun, Review, etc.
│   ├── api.ts           # Request/response shapes for every endpoint
│   ├── events.ts        # WebSocket event types
│   └── enums.ts         # TaskStatus, WorkflowRunStatus, ReviewStatus, etc.
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
    "code": "TASK_NOT_FOUND",
    "message": "Task with ID abc-123 does not exist",
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
  | { type: 'subscribe'; taskId: string; lastSeq?: number }
  | { type: 'unsubscribe'; taskId: string }

// Daemon → Client
type ServerMessage =
  | { type: 'task_output'; taskId: string; seq: number; data: AgentOutputEvent }
  | { type: 'task_status'; taskId: string; status: TaskStatus; reason?: string }
  | { type: 'workflow_status'; runId: string; status: WorkflowRunStatus; stage?: string }
  | { type: 'review_created'; reviewId: string; taskId: string }
  | { type: 'notification'; level: 'info' | 'warning' | 'error'; message: string }
```

Clients subscribe to specific task streams. Daemon pushes events for subscribed tasks plus global notifications (workflow status changes, review creation).

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
  │── SIGTERM ──────────────────────────►│  (on cancel)
  │◄── exit code ────────────────────────│
```

**ACP events parsed:** agent_message, agent_thought, tool_call, tool_result, session_update, result (usage stats).

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
│  • Tasks (status, output, etc.)   │  │  • Step execution log        │
│  • Task messages                  │  │  • Hook state (suspended)    │
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

**Consistency rule:** SQLite is the source of truth for entity state (task status, review status). Workflow event log is the source of truth for orchestration progression. The `"use step"` functions bridge between them — they read/write SQLite as side effects of workflow steps.

**Failure scenario:** If daemon crashes after a workflow step updates SQLite but before the workflow runtime records step completion → on restart, the step will re-execute (replay). Steps must be **idempotent** — re-creating an already-existing review should be a no-op, re-marking a task as completed should be safe.

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

tasks
  id TEXT PK
  projectId TEXT NOT NULL FK → projects.id
  workflowRunId TEXT  -- NULL for standalone tasks
  stageName TEXT
  agentDefinitionId TEXT NOT NULL FK → agentDefinitions.id
  credentialSetId TEXT FK → credentialSets.id
  originTaskId TEXT FK → tasks.id  -- rerun chain
  status TEXT NOT NULL DEFAULT 'pending'
  prompt TEXT NOT NULL
  title TEXT
  model TEXT
  useWorktree INTEGER NOT NULL DEFAULT 1
  baseBranch TEXT  -- branch to create worktree from
  targetBranch TEXT  -- branch to merge into on approval
  output TEXT
  lastAiMessage TEXT
  exitCode INTEGER
  failureReason TEXT  -- 'daemon_restart' | 'cancelled' | 'agent_error' | ...
  usageStats TEXT  -- JSON: {tokens, duration, cost, model}
  createdAt TEXT NOT NULL
  completedAt TEXT

taskMessages
  id TEXT PK
  taskId TEXT NOT NULL FK → tasks.id ON DELETE CASCADE
  role TEXT NOT NULL  -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL
  isIntervention INTEGER NOT NULL DEFAULT 0
  metadata TEXT  -- JSON: tool calls, reasoning
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
  taskDescription TEXT
  title TEXT
  status TEXT NOT NULL DEFAULT 'pending'
  currentStage TEXT
  acpSessionId TEXT  -- shared across stages for --continue
  credentialSetId TEXT FK → credentialSets.id
  baseBranch TEXT
  targetBranch TEXT
  createdAt TEXT NOT NULL
  completedAt TEXT

reviews
  id TEXT PK
  workflowRunId TEXT FK → workflowRuns.id
  taskId TEXT NOT NULL FK → tasks.id
  round INTEGER NOT NULL DEFAULT 1
  status TEXT NOT NULL DEFAULT 'pending_review'
  aiSummary TEXT
  diffSnapshot TEXT
  planMarkdown TEXT
  createdAt TEXT NOT NULL

  UNIQUE(taskId, round)  -- idempotency: prevent duplicate reviews on replay

reviewComments
  id TEXT PK
  reviewId TEXT NOT NULL FK → reviews.id ON DELETE CASCADE
  filePath TEXT  -- NULL for general (non-file-specific) comments
  lineNumber INTEGER
  side TEXT  -- 'left' | 'right'
  body TEXT NOT NULL
  createdAt TEXT NOT NULL

taskProposals
  id TEXT PK
  taskId TEXT NOT NULL FK → tasks.id ON DELETE CASCADE
  parallelGroupId TEXT FK → parallelGroups.id
  title TEXT NOT NULL
  description TEXT NOT NULL
  affectedFiles TEXT  -- JSON: string[]
  dependsOn TEXT  -- JSON: string[] (metadata only, not enforced)
  status TEXT NOT NULL DEFAULT 'proposed'
  launchedWorkflowRunId TEXT FK → workflowRuns.id
  sortOrder INTEGER NOT NULL DEFAULT 0
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(taskId, title)  -- idempotency: prevent duplicate proposals on replay

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
  taskId TEXT
  details TEXT  -- JSON
  createdAt TEXT NOT NULL

lastRunConfig
  id INTEGER PK DEFAULT 1  -- singleton
  projectId TEXT
  agentDefinitionId TEXT
  credentialSetId TEXT
  model TEXT
  useWorktree INTEGER
  workflowTemplateId TEXT
  updatedAt TEXT NOT NULL

pendingResumes
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
  taskId TEXT  -- for finalize
  parallelGroupId TEXT  -- for consolidate
  phase TEXT NOT NULL  -- 'commit' | 'rebase' | 'merge' | 'cleanup' | 'done'
  metadata TEXT  -- JSON: { targetBranch, mergedChildren: [], conflictChild, ... }
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(workflowRunId, type)  -- one active operation per workflow
```

### 4.3 Status Enums

```typescript
// Task lifecycle (simple state machine in daemon)
type TaskStatus = 'pending' | 'provisioning' | 'running' | 'completed' | 'failed' | 'cancelled'

// Workflow run lifecycle (driven by use workflow)
type WorkflowRunStatus = 'pending' | 'running' | 'stage_failed' | 'awaiting_review'
  | 'awaiting_proposals' | 'running_parallel' | 'finalizing'
  | 'completed' | 'failed' | 'cancelled'

// Review lifecycle
type ReviewStatus = 'pending_review' | 'approved' | 'changes_requested'

// Parallel group lifecycle
type ParallelGroupStatus = 'pending' | 'running' | 'consolidating'
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
│  • Manage Docker processes                       │
│  • Stream agent output                           │
│  • Manage WebSocket connections                  │
│  • Handle high-frequency events                  │
└────────────────────┬────────────────────────────┘
                     │ calls "use step" functions
                     ▼
┌─────────────────────────────────────────────────┐
│  Workflow Steps  (Bridge Layer)                  │
│                                                  │
│  Each step is a "use step" function that:        │
│  • Reads/writes SQLite (via services)            │
│  • Triggers task execution (via task-manager)    │
│  • Polls for task completion                     │
│  • Is idempotent (safe to re-execute on replay)  │
└────────────────────┬────────────────────────────┘
                     │ delegates to
                     ▼
┌─────────────────────────────────────────────────┐
│  Services  (Business Logic Layer)               │
│                                                  │
│  • task-manager: sandbox + worktree + ACP        │
│  • review-service: diff + summary + plan         │
│  • credential-vault: encrypt/decrypt/inject      │
│  • proposal-service: CRUD + parsing              │
│  • worktree: git operations                      │
│  • sandbox: Docker subprocess management         │
└─────────────────────────────────────────────────┘
```

### 5.2 Workflow ↔ Task Communication

The workflow does NOT hold a reference to the running task process. Instead:

```
Workflow step (execute-stage.ts):
  1. Check if task already exists for this (runId, stageName, round)
     → If yes and completed: return cached result (idempotent replay)
     → If yes and running: skip to step 3 (resume polling)
     → If yes and failed: skip to step 4 (return failure)
  2. Create task record in SQLite (status: pending)
     Call taskManager.startTask(taskId) → begins async execution
  3. Poll DB: SELECT status FROM tasks WHERE id = ? (every 2s)
  4. When status = 'completed' or 'failed': step returns result
  5. Step result is persisted by use workflow runtime

Task runtime (task-manager.ts):
  1. Receives startTask(taskId) call
  2. Checks current status: if already 'running', return (idempotent)
  3. Transitions task: pending → provisioning → running
  4. Launches sandbox, streams output via ACP client
  5. On completion: transitions task to completed/failed
  6. Writes output, usage stats, lastAiMessage to DB
  7. (Does NOT interact with workflow — the polling step detects completion)
```

This decoupling means:
- Task runtime has no dependency on `use workflow`
- Standalone tasks work identically (no workflow involved)
- Workflow steps are simple poll loops — easy to test
- **Steps are replay-safe**: check-before-act pattern prevents duplicate tasks/sandboxes

### 5.3 Hook Architecture

Three types of hooks suspend workflows for human input:

#### 5.3.1 Review Decision Hook

```
1. Workflow reaches hook: await reviewDecisionHook.create({ token: `review:${reviewId}` })
   → Workflow suspends. Hook state persisted to .workflow-data/

2. User clicks "Approve" in GUI
   → GUI sends POST /api/reviews/{id}/approve

3. Daemon route handler (atomic operation):
   a. INSERT INTO pendingResumes (hookToken, action, payload, createdAt)
   b. UPDATE reviews SET status = 'approved'
   c. Call resumeHook(`review:${reviewId}`, { action: 'approve' })
   d. On success: DELETE FROM pendingResumes WHERE hookToken = ...
   e. On failure: pending resume stays in table for startup reconciler

4. Workflow resumes from the hook point, receiving { action: 'approve' }

5. Startup reconciler (on daemon restart):
   SELECT * FROM pendingResumes
   For each: retry resumeHook() — ensures no stuck workflows
```

**Actions:** `{ action: 'approve' }` or `{ action: 'request_changes', comments: ReviewComment[] }`

#### 5.3.2 Stage Failed Hook

When a task fails mid-workflow, the execute-stage step detects `status = 'failed'` and the workflow creates a failure hook:

```
1. execute-stage step returns { status: 'failed', taskId, error }
2. Workflow updates workflowRun.status = 'stage_failed' in SQLite
3. Workflow reaches hook: await stageFailedHook.create({ token: `failed:${runId}:${stageName}` })
   → Workflow suspends

4. User decides via GUI:
   POST /api/workflows/runs/{id}/retry-stage   → resumes with { action: 'retry' }
   POST /api/workflows/runs/{id}/skip-stage    → resumes with { action: 'skip' }
   POST /api/workflows/runs/{id}/cancel        → resumes with { action: 'cancel' }

5. Workflow resumes:
   - retry: re-execute same stage (creates new task)
   - skip: advance to next stage (previousResult = null)
   - cancel: workflow moves to 'cancelled' state
```

#### 5.3.3 Proposal Review Hook

```
1. Split stage task completes → proposals extracted and stored in SQLite
2. Workflow updates workflowRun.status = 'awaiting_proposals'
3. Workflow reaches hook: await proposalReviewHook.create({ token: `proposals:${runId}` })
   → Workflow suspends

4. User reviews/edits proposals in GUI, clicks "Launch Selected"
   POST /api/proposals/launch → resumes with { proposalIds: [...], childStages: [...] }

5. Workflow resumes, launches child workflows
```

#### 5.3.4 Conflict Resolution Hook

Used during finalization (rebase conflict) and consolidation (merge conflict):

```
1. Finalize step: git rebase fails with conflict
   → Step creates conflictResolution record in SQLite
   → Workflow reaches hook: await conflictHook.create({ token: `conflict:${runId}` })
   → Workflow suspends, workflowRun.status = 'awaiting_conflict_resolution'

2. User resolves conflict externally (in their editor/terminal)
   POST /api/workflows/runs/{id}/resolve-conflict → resumes with { action: 'retry' }
   POST /api/workflows/runs/{id}/cancel           → resumes with { action: 'cancel' }

3. Workflow resumes:
   - retry: re-attempt rebase/merge (user should have resolved conflicts)
   - cancel: workflow fails with 'merge_conflict' reason
```

### 5.4 ACP Session Continuity

Session context is maintained across workflow stages for Copilot CLI:

```
Stage 1 (first stage):
  1. task-manager launches sandbox + copilot --acp --stdio --yolo --autopilot
  2. ACP client receives session initialization → extracts sessionId
  3. Stores sessionId on workflowRun.acpSessionId in SQLite
  4. Task completes, sandbox stops (but session state persists in Copilot's storage)

Stage 2 (continuation, freshSession=false):
  1. execute-stage reads workflowRun.acpSessionId
  2. Passes loadSessionId to task-manager
  3. task-manager launches sandbox with: copilot --acp --stdio --yolo --autopilot --continue
  4. ACP client sends session/load with stored sessionId
  5. Agent resumes with full context from Stage 1

Stage with freshSession=true:
  1. execute-stage passes loadSessionId=null
  2. New ACP session created (no --continue)
  3. Previous plan context injected as markdown in the prompt instead

Rerun (request_changes):
  1. Rerun task gets same loadSessionId as the original task
  2. Launched with --continue → agent remembers the original attempt
  3. Review comments bundled into the prompt as additional context

Split child workflows:
  1. Each child gets freshSession=true (independent context)
  2. Child's prompt includes the proposal description + task context
```

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

#### 5.5.2 Durable Git Operations Journal

Multi-step git operations (finalize, consolidate) use a journal table to track progress and enable safe resume after crash:

```
gitOperations
  id TEXT PK
  type TEXT NOT NULL  -- 'finalize' | 'consolidate'
  workflowRunId TEXT NOT NULL FK → workflowRuns.id
  taskId TEXT  -- for finalize
  parallelGroupId TEXT  -- for consolidate
  phase TEXT NOT NULL  -- 'commit' | 'rebase' | 'merge' | 'cleanup' | 'done'
  metadata TEXT  -- JSON: { targetBranch, mergedChildren: [], conflictChild, ... }
  createdAt TEXT NOT NULL
  updatedAt TEXT NOT NULL

  UNIQUE(workflowRunId, type)  -- one active operation per workflow
```

**Finalize phases:** `commit → rebase → merge → cleanup → done`
**Consolidate phases:** `merge_children → merge_to_target → cleanup → done`

On replay/restart, the step reads the journal and resumes from the last completed phase. Each phase is idempotent (checks if already done before acting).

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
- Sandbox name: `vibe-<shortId>` derived from task/origin ID

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
| Tasks | 8 | CRUD + start/cancel/message/diff |
| Workflows | 10 | Template CRUD + run start/status/delete + retry/skip/cancel + resolve-conflict |
| Reviews | 5 | Get + approve/reject + comments CRUD |
| Proposals | 5 | CRUD + launch |
| Parallel Groups | 2 | Status + consolidate |
| Credentials | 6 | Set CRUD + entry CRUD + audit |
| Agents | 4 | CRUD |
| Stats | 1 | Workspace summary |
| Health | 1 | Daemon health check |
| WebSocket | 1 | /ws — streaming + notifications |

### 8.2 API Versioning

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

- **Services** throw typed errors (e.g., `TaskNotFoundError`, `WorkflowNotRunningError`)
- **Routes** catch and map to HTTP status codes + standard error JSON
- **Workflow steps** catch and let `use workflow` handle retries (up to 3 by default)
- **Fatal errors** (e.g., corrupt DB) throw `FatalError` to skip retries
- **GUI** displays error toasts for API failures, inline errors for form validation

### 10.2 Logging

- **Daemon:** Pino structured JSON → `~/.vibe-harness/logs/daemon.log` (rotated)
- **Levels:** error, warn, info, debug
- **Context:** every log entry includes `{ taskId?, workflowRunId?, operation }`
- **Sensitive data:** credential values NEVER logged. Tokens masked.

### 10.3 Testing Strategy

| Layer | Test Type | Tools |
|-------|-----------|-------|
| Task state machine | Unit | Vitest |
| Services (diff parser, worktree, etc.) | Unit + Integration | Vitest |
| Workflow steps | Integration (mock services) | Vitest |
| API routes | Integration (supertest-like) | Vitest + Hono test client |
| Workflow durability | E2E (start, kill, restart, resume) | Custom test script |
| GUI components | Component tests | Vitest + React Testing Library |
| Full system | E2E (GUI → daemon → sandbox) | Playwright (Tauri) or manual |

### 10.5 Data Retention & Cleanup (NFR-R7)

Daemon runs a cleanup sweep on startup and daily (if running continuously):

- **Workflow state files** (`.workflow-data/`): runs older than 30 days (configurable) are deleted
- **Agent output in DB** (`tasks.output`): truncated to last 100KB for tasks older than 30 days
- **Orphaned worktrees**: worktrees with no matching active task, older than 7 days, are flagged in logs. User can delete via GUI or API
- **Orphaned Docker sandboxes**: stopped on startup reconciliation (§2.1.3)
- **Log rotation**: `daemon.log` rotated at 10MB, max 5 files

### 10.6 Seed Data (FR-A3, FR-W11)

On first database initialization (no existing data), daemon seeds:

- **Default Copilot CLI agent definition** (FR-A3): name "Copilot CLI", type "copilot_cli", commandTemplate "copilot", dockerImage "vibe-harness/copilot:latest"
- **Pre-built workflow templates** (FR-W11): "Plan → Implement → Commit" (3-stage), "Plan → Implement → Review → Fix → Commit" (5-stage)

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

Before starting a workflow, `workflow-engine` checks agent capabilities:
- Multi-stage with `freshSession=false`: agent must have `supportsContinue=true`
- Intervention required: agent must have `supportsIntervention=true`
- Streaming output: agent must have `supportsStreaming=true`

Validation fails fast with clear error before creating any tasks.

---

## 11. Traceability to SRD

| SRD Requirement | SAD Section |
|-------------|-------------|
| §2.2 Agent Definitions (FR-A1–A5) | §4.2 Schema, §10.8 Capability Validation |
| §2.3 Task Execution (FR-T1–T15) | §2.1 Daemon, §5.2 Workflow↔Task, §3.3 ACP, §5.5 Git Safety |
| §2.4 Workflow Orchestration (FR-W1–W16) | §5 Workflow Architecture, §4.1 Persistence, §5.3 Hooks |
| §2.5 Split Execution (FR-S1–S12) | §5.1 Separation of Concerns, §5.3.3 Proposal Hook, §5.5.2 Git Journal |
| §2.6 Human Review (FR-R1–R13) | §5.3.1 Review Hook, §5.3.4 Conflict Hook, §3.1-3.2 REST+WS |
| §2.7 Credentials (FR-C1–C8) | §6 Security Architecture, §4.2 Schema |
| §2.8 Dashboard (FR-D1–D3) | §8.1 Stats endpoint |
| §3.1 Installation (NFR-I1–I5) | §7 Deployment, §10.7 Prerequisites |
| §3.2 Performance (NFR-P1–P4) | §2.2.4 Streaming, §4.1 WAL mode |
| §3.3 Reliability (NFR-R1–R7) | §2.1.3 Reconciliation, §4.1 Consistency, §5.5.2 Git Journal, §10.5 Retention |
| §3.4 Security (NFR-S1–S7) | §6 Security Architecture, §10.1 Input Validation |
| §3.5 UX (NFR-U1–U8) | §2.2.2 Multi-Window, §2.2.3 Sidecar, §2.2.4 Streaming |
| §3.6 Observability (NFR-O1–O3) | §10.3 Logging, §8.1 Health endpoint |
