# Vibe Harness v2 — Component Detailed Design: GUI (Tauri + React)

## 0. Scope & References

This document specifies the internal design of the **GUI** component described in SAD §2.2. The GUI is a native desktop application built with Tauri 2.0 (Rust shell) and React (TypeScript frontend). It contains zero business logic — all state lives in the daemon (SAD §1.3 Principle 1).

| Reference | Section |
|-----------|---------|
| SAD §2.2 | GUI architecture, multi-window, sidecar lifecycle, streaming |
| SAD §3.1–3.2 | REST API and WebSocket protocol |
| SAD §4.3 | Status enums |
| SAD §2.3 | Shared types package |
| SRD §3.5 | UX requirements (NFR-U1–U8) |

---

## 1. Tauri Shell (`src-tauri/`)

### 1.1 `lib.rs` — Sidecar Management

The Rust layer is minimal — it manages the daemon sidecar lifecycle and exposes a few Tauri commands to the frontend.

**Responsibilities:**
- Start daemon sidecar on app launch (SAD §2.2.3)
- Discover daemon port via port file polling
- Health-check the daemon (HTTP `GET /health`)
- Restart sidecar if the daemon process dies
- Provide file-system access to `~/.vibe-harness/auth.token`

**Sidecar detach policy (SAD §2.2.3):** The daemon sidecar is spawned in detached mode so that it **survives GUI close**. The daemon is a long-running background service — closing the Tauri window must NOT kill it. Users can explicitly stop the daemon from Settings or system tray.

- On spawn: call `sidecar.detach()` (Tauri 2.0 `CommandChild::detach()`) immediately after `Command::new_sidecar("daemon").spawn()`. This releases the child process from Tauri's process group.
- On Tauri exit: register a `RunEvent::ExitRequested` handler that does **not** send SIGTERM to the sidecar PID. Default Tauri behavior kills child processes — detach prevents this.
- The daemon writes its own PID to `~/.vibe-harness/daemon.pid` and cleans it up on graceful shutdown (SIGTERM/SIGINT).

```rust
// In tauri::Builder setup:
.setup(|app| {
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let info = start_daemon(app_handle.clone()).await.unwrap();
        // Start background health monitor
        monitor_daemon(app_handle, info.port).await;
    });
    Ok(())
})
.on_event(|_app, event| {
    // Do NOT kill the daemon sidecar on window close.
    // The daemon survives GUI close for background workflow execution.
    if let tauri::RunEvent::ExitRequested { .. } = event {
        // No-op: daemon continues running.
        // Sidecar was detached at spawn time — Tauri won't kill it.
    }
})
```

**Tauri commands exposed to frontend:**

```rust
/// Start the daemon sidecar if not already running.
/// Returns the daemon port once ready.
///
/// Lifecycle (SAD §2.2.3):
///   1. Check daemon.pid — if alive, read daemon.port and return
///   2. Spawn sidecar via Command::new_sidecar("daemon").spawn()
///   3. Immediately call child.detach() — daemon survives GUI close
///   4. Poll ~/.vibe-harness/daemon.port every 200ms, timeout 30s
///   5. HTTP GET http://localhost:<port>/health — confirm ready
///   6. Store port in app state (for pop-out windows to read)
///   7. Return port
#[tauri::command]
async fn start_daemon(app: AppHandle) -> Result<DaemonInfo, String>;

/// Read the auth token from ~/.vibe-harness/auth.token.
/// Used by the frontend to authenticate API requests.
#[tauri::command]
async fn read_auth_token() -> Result<String, String>;

/// Health-check the daemon. Returns Ok if reachable, Err otherwise.
#[tauri::command]
async fn check_daemon_health(port: u16) -> Result<HealthStatus, String>;

/// Create a new Tauri WebviewWindow for pop-out views (NFR-U1).
/// `route` is the URL path to load (e.g., "/run/abc-123").
#[tauri::command]
async fn open_popout_window(
    app: AppHandle,
    route: String,
    title: String,
) -> Result<(), String>;

/// Read the current daemon port from Tauri app state.
/// Used by pop-out windows to avoid calling start_daemon() (which could race).
/// Returns Err if no daemon has been started yet (main window hasn't booted).
#[tauri::command]
async fn get_daemon_port(state: State<'_, DaemonPortState>) -> Result<u16, String> {
    Ok(state.get())
}
```

**Daemon crash detection & restart:**

```rust
// Spawned as a background task after initial sidecar start.
// IMPORTANT: After restart, the daemon may listen on a DIFFERENT port
// and may have regenerated its auth token. The Connected event carries
// the new port so the frontend can reconnect WS and re-read the token.
async fn monitor_daemon(app: AppHandle, mut current_port: u16) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        match check_daemon_health(current_port).await {
            Ok(_) => continue,
            Err(_) => {
                // Daemon unreachable — emit event to frontend
                app.emit("daemon-status", DaemonEvent::Disconnected).ok();
                // Attempt restart (spawns new sidecar, detached)
                match start_daemon(app.clone()).await {
                    Ok(info) => {
                        // Port may have changed after restart
                        current_port = info.port;
                        // Store new port in Tauri app state for pop-out windows
                        app.state::<DaemonPortState>().set(info.port);
                        app.emit("daemon-status", DaemonEvent::Connected {
                            port: info.port,
                        }).ok();
                    }
                    Err(e) => {
                        app.emit("daemon-status", DaemonEvent::RestartFailed {
                            error: e,
                        }).ok();
                    }
                }
            }
        }
    }
}
```

**Types (Rust side):**

```rust
#[derive(Serialize, Clone)]
struct DaemonInfo {
    port: u16,
    pid: u32,
}

#[derive(Serialize, Clone)]
struct HealthStatus {
    status: String,      // "ok"
    uptime_secs: u64,
    active_runs: u32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum DaemonEvent {
    Connected { port: u16 },
    Disconnected,
    RestartFailed { error: String },
}

/// Shared state for daemon port, readable by pop-out windows via Tauri command.
/// Updated by monitor_daemon on restart. Avoids pop-out windows calling
/// start_daemon() themselves (which could race with the main window).
struct DaemonPortState(Mutex<u16>);

impl DaemonPortState {
    fn set(&self, port: u16) { *self.0.lock().unwrap() = port; }
    fn get(&self) -> u16 { *self.0.lock().unwrap() }
}
```

### 1.2 `tauri.conf.json` — Configuration

```jsonc
{
  "productName": "Vibe Harness",
  "identifier": "com.vibe-harness.app",
  "build": {
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Vibe Harness",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://localhost:* ws://localhost:*"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "appimage"],
    "externalBin": ["daemon"],
    "icon": ["icons/icon.icns", "icons/icon.png"]
  },
  "plugins": {
    "shell": {
      "sidecar": true
    },
    "fs": {
      "scope": ["$HOME/.vibe-harness/**"]
    }
  }
}
```

**Key decisions:**
- `externalBin: ["daemon"]` — daemon ships as a sidecar binary (SAD §7.1)
- `fs.scope` restricted to `~/.vibe-harness/` — only auth token and config files
- CSP allows localhost connections for daemon communication
- Window defaults: 1280×800, minimum 900×600

---

## 2. App Structure

### 2.1 Router Setup (TanStack Router)

TanStack Router chosen for type-safe routing and search-param serialization.

```
src/
├── main.tsx              # createRoot, mount <App />
├── App.tsx               # RouterProvider + global providers
├── router.ts             # Route tree definition
└── routes/
    ├── __root.tsx         # Root layout: sidebar + main content + daemon status
    ├── workspace.tsx      # / — main workspace (run feed + detail panel)
    ├── workspace.$runId.tsx  # /workspace/$runId — selected run
    ├── projects.tsx       # /projects — project CRUD
    ├── workflows.tsx      # /workflows — template editor
    ├── credentials.tsx    # /credentials — vault management
    └── settings.tsx       # /settings — agent definitions, preferences
```

**Route definitions:**

```typescript
// router.ts
import { createRouter, createRoute, createRootRoute } from '@tanstack/react-router';

const rootRoute = createRootRoute({ component: RootLayout });

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspacePage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/workspace/$runId',
  component: WorkspacePage,  // same page, detail panel shows run
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
  component: WorkflowsPage,
});

const credentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credentials',
  component: CredentialsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
```

### 2.2 Layout: Sidebar Navigation + Main Content

```
┌──────────────────────────────────────────────────────┐
│  ┌──────┐  ┌──────────────────────────────────────┐  │
│  │      │  │  DaemonStatus (top bar)               │  │
│  │ Side │  ├──────────────────────────────────────┤  │
│  │ bar  │  │                                      │  │
│  │      │  │  <Outlet /> (page content)            │  │
│  │ Nav  │  │                                      │  │
│  │      │  │                                      │  │
│  │      │  │                                      │  │
│  └──────┘  └──────────────────────────────────────┘  │
│  [⌘K]                                                │
└──────────────────────────────────────────────────────┘
```

**RootLayout component:**

```typescript
interface SidebarNavItem {
  label: string;
  icon: string;           // Lucide icon name
  path: string;
  badge?: number;         // e.g., pending review count
}

// RootLayout renders:
// 1. Sidebar: navigation items + daemon status icon
// 2. Top bar: DaemonStatus banner (shown when disconnected)
// 3. Main content area: <Outlet />
// 4. CommandPalette (hidden, activated by ⌘K)
// 5. Toast container (sonner)
```

### 2.3 Theme & Styling

- **Tailwind CSS v4** — utility-first styling
- **shadcn/ui** — component library (Button, Dialog, Select, Tabs, Tooltip, etc.)
- **Lucide React** — icon library (consistent with shadcn/ui)
- **Dark mode only** — developer tool, matches IDE aesthetic
- **CSS variables** for theming via shadcn/ui convention:

```css
/* globals.css */
:root {
  --background: 224 71% 4%;
  --foreground: 213 31% 91%;
  --card: 224 71% 4%;
  --primary: 210 40% 98%;
  --muted: 223 47% 11%;
  --accent: 216 34% 17%;
  --destructive: 0 63% 31%;
  /* Status-specific colors */
  --status-running: 142 76% 36%;
  --status-awaiting: 38 92% 50%;
  --status-failed: 0 84% 60%;
  --status-completed: 142 71% 45%;
}
```

**Additional libraries:**
- **sonner** — toast notifications (stage complete, review created, errors)
- **cmdk** — command palette foundation (⌘K)
- **@tanstack/react-virtual** — virtualized lists for long streaming output

---

## 3. State Management (Zustand Stores)

### 3.1 `stores/workspace.ts` — Run List & Selection

```typescript
import { create } from 'zustand';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  Project,
} from '@vibe-harness/shared';

// ── Filter & Sort ──

type RunSortField = 'createdAt' | 'updatedAt' | 'status';
type RunSortDirection = 'asc' | 'desc';

interface RunFilters {
  status: WorkflowRunStatus[] | null;   // null = all statuses
  projectId: string | null;             // null = all projects
  searchText: string;                   // free-text search on title/description
}

// ── Store Shape ──

interface WorkspaceState {
  // Data
  runs: WorkflowRun[];
  projects: Project[];

  // Selection
  selectedRunId: string | null;

  // Filters & sort
  filters: RunFilters;
  sort: { field: RunSortField; direction: RunSortDirection };

  // Loading states
  isLoadingRuns: boolean;
  isLoadingProjects: boolean;

  // Derived (computed via selector, not stored)
  // filteredRuns: WorkflowRun[]  — use useFilteredRuns() selector

  // Actions
  setRuns: (runs: WorkflowRun[]) => void;
  upsertRun: (run: WorkflowRun) => void;     // from WS run_status events
  removeRun: (runId: string) => void;
  selectRun: (runId: string | null) => void;
  setFilters: (filters: Partial<RunFilters>) => void;
  setSort: (field: RunSortField, direction: RunSortDirection) => void;
  setProjects: (projects: Project[]) => void;
  setLoadingRuns: (loading: boolean) => void;
  setLoadingProjects: (loading: boolean) => void;
}

// ── Last-Viewed Run Persistence (NFR-U8) ──

const LAST_RUN_KEY = 'vibe-harness:lastViewedRunId';

// selectRun implementation persists to localStorage:
// selectRun: (runId) => {
//   set({ selectedRunId: runId });
//   if (runId) localStorage.setItem(LAST_RUN_KEY, runId);
//   else localStorage.removeItem(LAST_RUN_KEY);
// }
//
// On bootstrap, restore last-viewed run:
// const lastRunId = localStorage.getItem(LAST_RUN_KEY);
// if (lastRunId) useWorkspaceStore.getState().selectRun(lastRunId);
//
// NOTE: This is "last-viewed run" (which run to re-select on restart).
// It is separate from lastRunConfig (which remembers form field values
// for the New Run modal — project, template, credential set, etc.).

// ── Selectors ──

/**
 * Returns runs matching current filters, sorted by current sort config.
 *
 * Uses individual Zustand selectors + useMemo to avoid recomputing on
 * every unrelated store change. The inline-filtering-in-selector pattern
 * creates a new array reference on every call, causing unnecessary re-renders.
 */
function useFilteredRuns(): WorkflowRun[] {
  const runs = useWorkspaceStore((s) => s.runs);
  const filters = useWorkspaceStore((s) => s.filters);
  const sort = useWorkspaceStore((s) => s.sort);

  return useMemo(() => {
    let result = runs;

    // Apply filters
    if (filters.status) {
      result = result.filter((r) => filters.status!.includes(r.status));
    }
    if (filters.projectId) {
      result = result.filter((r) => r.projectId === filters.projectId);
    }
    if (filters.searchText) {
      const q = filters.searchText.toLowerCase();
      result = result.filter(
        (r) =>
          r.title?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q)
      );
    }

    // Apply sort
    const { field, direction } = sort;
    result = [...result].sort((a, b) => {
      const av = a[field] ?? '';
      const bv = b[field] ?? '';
      return direction === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

    return result;
  }, [runs, filters, sort]);
}
```

### 3.2 `stores/streaming.ts` — Per-Run Output Buffer & Transform Layer

```typescript
import type { AgentOutputEvent, RunMessage } from '@vibe-harness/shared';

// ── Types ──

/** A single streaming event with sequence tracking. */
interface StreamEvent {
  seq: number;
  stage: string;
  data: AgentOutputEvent;
  receivedAt: number;        // Date.now() for latency tracking
}

/** Buffer state for a single workflow run. */
interface RunStreamBuffer {
  events: StreamEvent[];
  lastSeq: number;           // highest seq seen (for reconnect replay)
  isLive: boolean;           // actively receiving events
  needsResync: boolean;      // set when daemon sends resync_required
}

/** Session boundary marker for rendering conversation view. */
interface SessionBoundary {
  sessionIndex: number;
  stageName: string;
  timestamp: string;
}

/**
 * A conversation block is the renderable unit in RunConversation.
 * The transform layer converts raw AgentOutputEvents into these blocks.
 */
type ConversationBlock =
  | { type: 'user_message'; content: string; stageName: string; isIntervention: boolean; timestamp: string }
  | { type: 'assistant_message'; content: string; isStreaming: boolean; stageName: string; timestamp: string }
  | { type: 'tool_group'; calls: ToolCallWithResult[]; stageName: string; timestamp: string }
  | { type: 'agent_thought'; content: string; stageName: string; timestamp: string }
  | { type: 'system_message'; content: string; timestamp: string }
  | { type: 'session_boundary'; sessionIndex: number; stageName: string; timestamp: string };

interface ToolCallWithResult {
  id: string;
  name: string;
  arguments: string;           // JSON string
  result?: string;             // filled when tool_result arrives
  status?: 'pending' | 'success' | 'error';
}

// ── Store Shape ──

interface StreamingState {
  // Per-run raw event buffers (Map<runId, buffer>)
  buffers: Record<string, RunStreamBuffer>;

  // Conversation history (fetched from REST, augmented by stream)
  conversations: Record<string, RunMessage[]>;

  // Transformed conversation blocks for rendering
  conversationBlocks: Record<string, ConversationBlock[]>;

  // Session boundaries for rendering
  sessionBoundaries: Record<string, SessionBoundary[]>;

  // Currently streaming assistant message (per run) — the "tail"
  streamingTail: Record<string, { content: string; stageName: string } | null>;

  // Actions
  /** Initialize buffer when subscribing to a run's stream. */
  initBuffer: (runId: string) => void;

  /** Append a streaming event. Drops duplicates (seq ≤ lastSeq). */
  appendEvent: (runId: string, event: StreamEvent) => void;

  /** Bulk-load events after REST resync (buffer overflow recovery). */
  resyncFromRest: (runId: string, messages: RunMessage[]) => void;

  /** Mark a run as needing resync (daemon sent resync_required). */
  markResyncRequired: (runId: string) => void;

  /** Mark a run's stream as ended (agent completed or failed). */
  markStreamEnded: (runId: string) => void;

  /** Remove buffer when user navigates away or unsubscribes. */
  clearBuffer: (runId: string) => void;

  /** Set full conversation history from REST fetch. */
  setConversation: (runId: string, messages: RunMessage[]) => void;

  /** Append a message to conversation (from streaming or intervention). */
  appendMessage: (runId: string, message: RunMessage) => void;
}

// ── Constants ──

/** Max events in a single run buffer before oldest are evicted. */
const MAX_BUFFER_SIZE = 10_000;
```

#### 3.2.1 Transform Layer: AgentOutputEvent → ConversationBlock[]

The streaming store does not expose raw events to components. Instead, `appendEvent` triggers a transform step that maintains `conversationBlocks` — the renderable conversation.

**Transform rules:**

```typescript
// Invoked by appendEvent() after buffering the raw event.
function transformEvent(
  blocks: ConversationBlock[],
  tail: { content: string; stageName: string } | null,
  event: StreamEvent,
): { blocks: ConversationBlock[]; tail: typeof tail } {
  const { data, stage } = event;

  switch (data.type) {
    case 'agent_message': {
      // Agent message events may arrive as a stream of partial chunks
      // (data.partial === true) or as a complete message (data.partial === false).
      if (data.partial) {
        // Append to streaming tail (Streamdown renders this incrementally)
        const current = tail ?? { content: '', stageName: stage };
        return {
          blocks,
          tail: { ...current, content: current.content + data.content },
        };
      }
      // Complete message: finalize tail into a block
      const finalContent = tail ? tail.content + (data.content ?? '') : data.content;
      return {
        blocks: [...blocks, {
          type: 'assistant_message',
          content: finalContent,
          isStreaming: false,
          stageName: stage,
          timestamp: data.timestamp,
        }],
        tail: null,
      };
    }

    case 'tool_call': {
      // Start a new tool group or append to the last one
      const lastBlock = blocks[blocks.length - 1];
      const toolEntry: ToolCallWithResult = {
        id: data.id,
        name: data.name,
        arguments: data.arguments,
        status: 'pending',
      };

      if (lastBlock?.type === 'tool_group' && lastBlock.stageName === stage) {
        // Append to existing group (consecutive tool calls are grouped)
        const updated = { ...lastBlock, calls: [...lastBlock.calls, toolEntry] };
        return { blocks: [...blocks.slice(0, -1), updated], tail };
      }
      // New tool group
      return {
        blocks: [...blocks, {
          type: 'tool_group',
          calls: [toolEntry],
          stageName: stage,
          timestamp: data.timestamp,
        }],
        tail,
      };
    }

    case 'tool_result': {
      // Find the tool_call in the most recent tool_group and attach result
      const updated = [...blocks];
      for (let i = updated.length - 1; i >= 0; i--) {
        const block = updated[i];
        if (block.type === 'tool_group') {
          const callIdx = block.calls.findIndex((c) => c.id === data.callId);
          if (callIdx >= 0) {
            const calls = [...block.calls];
            calls[callIdx] = {
              ...calls[callIdx],
              result: data.content,
              status: data.isError ? 'error' : 'success',
            };
            updated[i] = { ...block, calls };
            break;
          }
        }
      }
      return { blocks: updated, tail };
    }

    case 'agent_thought': {
      return {
        blocks: [...blocks, {
          type: 'agent_thought',
          content: data.content,
          stageName: stage,
          timestamp: data.timestamp,
        }],
        tail,
      };
    }

    case 'session_update': {
      // Session boundary (freshSession reset)
      return {
        blocks: [...blocks, {
          type: 'session_boundary',
          sessionIndex: data.sessionIndex,
          stageName: stage,
          timestamp: data.timestamp,
        }],
        tail: null,  // reset tail on session boundary
      };
    }

    case 'result': {
      // Usage stats — not rendered as a block, but finalizes any open tail
      if (tail) {
        return {
          blocks: [...blocks, {
            type: 'assistant_message',
            content: tail.content,
            isStreaming: false,
            stageName: tail.stageName,
            timestamp: data.timestamp,
          }],
          tail: null,
        };
      }
      return { blocks, tail };
    }

    default:
      return { blocks, tail };
  }
}
```

**How Streamdown consumes this:** Only the `streamingTail` (the live, incomplete assistant message) is rendered with Streamdown. All finalized `assistant_message` blocks are rendered as static markdown (see §8.1). This avoids creating Streamdown instances for completed messages.

**REST resync (`resyncFromRest`):** When resync is needed, the full `RunMessage[]` from REST is bulk-converted to `ConversationBlock[]` using the same transform rules (applied sequentially). The `streamingTail` is cleared since the REST response contains only finalized messages.

### 3.3 `stores/daemon.ts` — Connection Status

```typescript
// ── Types ──

type DaemonConnectionStatus =
  | 'connecting'       // initial connection attempt
  | 'connected'        // healthy, WS open
  | 'disconnected'     // WS closed, attempting reconnect
  | 'reconnecting'     // actively retrying
  | 'failed';          // sidecar restart failed

interface PrerequisiteResult {
  name: string;
  status: 'ok' | 'missing' | 'error';
  message: string;
  fixInstructions?: string;
}

// ── Store Shape ──

interface DaemonState {
  // Connection
  status: DaemonConnectionStatus;
  port: number | null;
  authToken: string | null;

  // Health
  lastHealthCheck: number | null;      // timestamp
  activeRunCount: number;

  // Reconnect tracking
  reconnectAttempts: number;
  maxReconnectAttempts: number;        // default: 10
  nextReconnectAt: number | null;      // timestamp of next retry

  // Prerequisites (checked on first launch)
  prerequisites: PrerequisiteResult[] | null;
  prerequisitesLoading: boolean;

  // Actions
  setStatus: (status: DaemonConnectionStatus) => void;
  setPort: (port: number) => void;
  setAuthToken: (token: string) => void;
  updateHealth: (activeRuns: number) => void;
  incrementReconnectAttempts: () => void;
  resetReconnectAttempts: () => void;
  setNextReconnectAt: (timestamp: number | null) => void;
  setPrerequisites: (results: PrerequisiteResult[]) => void;
  setPrerequisitesLoading: (loading: boolean) => void;
}
```

---

## 4. API Client (`api/client.ts`)

Typed fetch wrapper consuming shared types. All mutations go through the daemon API (SAD §1.3 Principle 3).

### 4.1 Core Client

```typescript
import { invoke } from '@tauri-apps/api/core';
import type {
  Project, WorkflowRun, WorkflowTemplate, Review,
  ReviewComment, Proposal, ParallelGroup, AgentDefinition,
  CredentialSet, StageExecution, RunMessage,
  WorkflowRunStatus,
} from '@vibe-harness/shared';

// ── Error Type ──

interface ApiError {
  code: string;       // e.g., "RUN_NOT_FOUND"
  message: string;
  details?: Record<string, unknown>;
}

class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiError: ApiError,
  ) {
    super(apiError.message);
    this.name = 'ApiClientError';
  }
}

// ── Config ──

interface ClientConfig {
  getBaseUrl: () => string;      // http://localhost:<port>
  getAuthToken: () => string;    // Bearer token
}

// ── Typed Fetch Wrapper ──

class ApiClient {
  constructor(private config: ClientConfig) {}

  /** Update the base URL (e.g., after daemon restarts on a new port). */
  updateBaseUrl(newBaseUrl: string): void {
    const oldGetBaseUrl = this.config.getBaseUrl;
    this.config = { ...this.config, getBaseUrl: () => newBaseUrl };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.config.getBaseUrl());
    if (query) {
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.getAuthToken()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err: { error: ApiError } = await res.json();
      throw new ApiClientError(res.status, err.error);
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ── Projects (SAD §8.2) ──

  listProjects(): Promise<Project[]> {
    return this.request('GET', '/api/projects');
  }
  getProject(id: string): Promise<Project> {
    return this.request('GET', `/api/projects/${id}`);
  }
  createProject(data: CreateProjectInput): Promise<Project> {
    return this.request('POST', '/api/projects', data);
  }
  updateProject(id: string, data: UpdateProjectInput): Promise<Project> {
    return this.request('PUT', `/api/projects/${id}`, data);
  }
  deleteProject(id: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}`);
  }
  listBranches(projectId: string): Promise<string[]> {
    return this.request('GET', `/api/projects/${projectId}/branches`);
  }

  // ── Runs (SAD §8.2) ──

  listRuns(query?: {
    status?: WorkflowRunStatus;
    projectId?: string;
  }): Promise<WorkflowRun[]> {
    const q: Record<string, string> = {};
    if (query?.status) q.status = query.status;
    if (query?.projectId) q.projectId = query.projectId;
    return this.request('GET', '/api/runs', undefined, q);
  }
  createRun(data: CreateRunInput): Promise<WorkflowRun> {
    return this.request('POST', '/api/runs', data);
  }
  getRun(id: string): Promise<WorkflowRunDetail> {
    return this.request('GET', `/api/runs/${id}`);
  }
  deleteRun(id: string): Promise<void> {
    return this.request('DELETE', `/api/runs/${id}`);
  }
  cancelRun(id: string): Promise<void> {
    return this.request('PATCH', `/api/runs/${id}/cancel`);
  }
  sendMessage(runId: string, message: string): Promise<void> {
    return this.request('POST', `/api/runs/${runId}/message`, { message });
  }
  getRunDiff(runId: string): Promise<DiffResponse> {
    return this.request('GET', `/api/runs/${runId}/diff`);
  }
  getRunMessages(runId: string): Promise<RunMessage[]> {
    return this.request('GET', `/api/runs/${runId}/messages`);
  }
  retryStage(runId: string): Promise<void> {
    return this.request('POST', `/api/runs/${runId}/retry-stage`);
  }
  skipStage(runId: string): Promise<void> {
    return this.request('POST', `/api/runs/${runId}/skip-stage`);
  }
  resolveConflict(runId: string): Promise<void> {
    return this.request('POST', `/api/runs/${runId}/resolve-conflict`);
  }

  // ── Reviews (SAD §8.2) ──

  listReviews(runId: string, stageName?: string): Promise<Review[]> {
    const q: Record<string, string> = { runId };
    if (stageName) q.stageName = stageName;
    return this.request('GET', '/api/reviews', undefined, q);
  }
  getReview(id: string): Promise<ReviewDetail> {
    return this.request('GET', `/api/reviews/${id}`);
  }
  approveReview(id: string): Promise<void> {
    return this.request('POST', `/api/reviews/${id}/approve`);
  }
  requestChanges(id: string): Promise<void> {
    return this.request('POST', `/api/reviews/${id}/request-changes`);
  }
  addComment(reviewId: string, data: CreateCommentInput): Promise<ReviewComment> {
    return this.request('POST', `/api/reviews/${reviewId}/comments`, data);
  }
  getComments(reviewId: string): Promise<ReviewComment[]> {
    return this.request('GET', `/api/reviews/${reviewId}/comments`);
  }

  // ── Proposals ──

  listProposals(runId: string): Promise<Proposal[]> {
    return this.request('GET', `/api/proposals`, undefined, { runId });
  }
  updateProposal(id: string, data: UpdateProposalInput): Promise<Proposal> {
    return this.request('PUT', `/api/proposals/${id}`, data);
  }
  launchProposals(proposalIds: string[]): Promise<void> {
    return this.request('POST', '/api/proposals/launch', { proposalIds });
  }

  // ── Parallel Groups ──

  getParallelGroup(id: string): Promise<ParallelGroupDetail> {
    return this.request('GET', `/api/parallel-groups/${id}`);
  }
  consolidate(groupId: string): Promise<void> {
    return this.request('POST', `/api/parallel-groups/${groupId}/consolidate`);
  }
  consolidatePartial(groupId: string): Promise<void> {
    return this.request('POST', `/api/parallel-groups/${groupId}/consolidate-partial`);
  }
  retryChildren(groupId: string, childRunIds: string[]): Promise<void> {
    return this.request('POST', `/api/parallel-groups/${groupId}/retry-children`, { childRunIds });
  }
  cancelParallelGroup(groupId: string): Promise<void> {
    return this.request('POST', `/api/parallel-groups/${groupId}/cancel`);
  }

  // ── Workflow Templates (SAD §8.2) ──

  listTemplates(): Promise<WorkflowTemplate[]> {
    return this.request('GET', '/api/workflows');
  }
  createTemplate(data: CreateTemplateInput): Promise<WorkflowTemplate> {
    return this.request('POST', '/api/workflows', data);
  }
  getTemplate(id: string): Promise<WorkflowTemplate> {
    return this.request('GET', `/api/workflows/${id}`);
  }
  updateTemplate(id: string, data: UpdateTemplateInput): Promise<WorkflowTemplate> {
    return this.request('PUT', `/api/workflows/${id}`, data);
  }
  deleteTemplate(id: string): Promise<void> {
    return this.request('DELETE', `/api/workflows/${id}`);
  }

  // ── Credentials ──

  listCredentialSets(): Promise<CredentialSet[]> {
    return this.request('GET', '/api/credentials');
  }
  createCredentialSet(data: CreateCredentialSetInput): Promise<CredentialSet> {
    return this.request('POST', '/api/credentials', data);
  }
  deleteCredentialSet(id: string): Promise<void> {
    return this.request('DELETE', `/api/credentials/${id}`);
  }
  addCredentialEntry(setId: string, data: CreateCredentialEntryInput): Promise<void> {
    return this.request('POST', `/api/credentials/${setId}/entries`, data);
  }
  deleteCredentialEntry(setId: string, entryId: string): Promise<void> {
    return this.request('DELETE', `/api/credentials/${setId}/entries/${entryId}`);
  }

  // ── Agents ──

  listAgents(): Promise<AgentDefinition[]> {
    return this.request('GET', '/api/agents');
  }
  createAgent(data: CreateAgentInput): Promise<AgentDefinition> {
    return this.request('POST', '/api/agents', data);
  }
  updateAgent(id: string, data: UpdateAgentInput): Promise<AgentDefinition> {
    return this.request('PUT', `/api/agents/${id}`, data);
  }
  deleteAgent(id: string): Promise<void> {
    return this.request('DELETE', `/api/agents/${id}`);
  }

  // ── Health & Stats ──

  health(): Promise<HealthStatus> {
    return this.request('GET', '/health');
  }
  prerequisites(): Promise<PrerequisiteResult[]> {
    return this.request('GET', '/api/prerequisites');
  }
  stats(): Promise<WorkspaceStats> {
    return this.request('GET', '/api/stats');
  }
}
```

### 4.2 Request/Response Input Types

```typescript
// These are GUI-side input shapes; the full shared types define entity shapes.

interface CreateProjectInput {
  localPath: string;
  name?: string;
  description?: string;
}

interface UpdateProjectInput {
  name?: string;
  description?: string;
  defaultCredentialSetId?: string | null;
}

interface CreateRunInput {
  projectId: string;
  workflowTemplateId: string;
  agentDefinitionId: string;
  description: string;
  credentialSetId?: string;
  baseBranch?: string;
  targetBranch?: string;
}

interface CreateCommentInput {
  body: string;
  filePath?: string;       // null for general comments
  lineNumber?: number;
  side?: 'left' | 'right';
}

interface CreateTemplateInput {
  name: string;
  description?: string;
  stages: WorkflowStageInput[];
}

interface UpdateTemplateInput {
  name?: string;
  description?: string;
  stages?: WorkflowStageInput[];
}

interface WorkflowStageInput {
  name: string;
  type: 'standard' | 'split';
  promptTemplate: string;
  reviewRequired?: boolean;
  autoAdvance?: boolean;
  freshSession?: boolean;
}

interface UpdateProposalInput {
  title?: string;
  description?: string;
  affectedFiles?: string[];
  workflowTemplateOverride?: string;
  status?: 'approved' | 'discarded';
  sortOrder?: number;
}

interface CreateCredentialSetInput {
  name: string;
  description?: string;
  projectId?: string;        // null for global
}

interface CreateCredentialEntryInput {
  key: string;
  value: string;             // plaintext — encrypted by daemon
  type: 'env_var' | 'file_mount' | 'docker_login' | 'host_dir_mount' | 'command_extract';
  mountPath?: string;
  command?: string;
}

interface CreateAgentInput {
  name: string;
  type: string;
  commandTemplate: string;
  dockerImage?: string;
  description?: string;
  supportsStreaming?: boolean;
  supportsContinue?: boolean;
  supportsIntervention?: boolean;
  outputFormat?: 'acp' | 'jsonl' | 'text';
}

interface UpdateAgentInput extends Partial<CreateAgentInput> {}

// ── Response Types ──

interface WorkflowRunDetail extends WorkflowRun {
  stages: StageExecution[];
  activeReview?: Review;
  parallelGroup?: ParallelGroup;
}

interface ReviewDetail extends Review {
  comments: ReviewComment[];
  diff: DiffFile[];
}

interface ParallelGroupDetail extends ParallelGroup {
  children: WorkflowRun[];
  proposals: Proposal[];
}

interface DiffResponse {
  files: DiffFile[];
  stats: { additions: number; deletions: number; filesChanged: number };
}

interface DiffFile {
  path: string;
  oldPath?: string;          // for renames
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface WorkspaceStats {
  runningWorkflows: number;
  pendingReviews: number;
  recentActivity: ActivityItem[];
}

interface ActivityItem {
  type: 'run_started' | 'run_completed' | 'review_created' | 'stage_completed';
  runId: string;
  message: string;
  timestamp: string;
}
```

### 4.3 Auth Token Management

```typescript
// api/auth.ts
import { invoke } from '@tauri-apps/api/core';

let cachedToken: string | null = null;

/** Read auth token from Tauri sidecar (reads ~/.vibe-harness/auth.token). */
export async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = await invoke<string>('read_auth_token');
  return cachedToken;
}

export function clearCachedToken(): void {
  cachedToken = null;
}
```

---

## 5. WebSocket Manager (`api/ws.ts`)

Single WebSocket connection per window. Manages subscription, reconnection, and event dispatch to Zustand stores (SAD §3.2).

### 5.1 Connection Lifecycle

**WS authentication via query parameter:** The auth token is passed as a query parameter (`?token=...`) on the WebSocket upgrade request. This is acceptable because the daemon binds to localhost only (NFR-S4) — the token never traverses a network. The alternative — sending the token as the first message after connection — would require the daemon to buffer events until auth completes, adding complexity. If localhost-only changes in the future, switch to a first-message auth handshake or use the `Sec-WebSocket-Protocol` header.

```typescript
import type {
  ClientMessage,
  ServerMessage,
  WorkflowRunStatus,
  StageStatus,
  AgentOutputEvent,
} from '@vibe-harness/shared';

// ── ServerMessage Extension ──
// The shared types define the base ServerMessage union (SAD §3.2).
// resync_required is an additional event type sent when the daemon's
// per-run event buffer overflows (SAD §2.2.4):
//
// type ServerMessage =
//   | { type: 'run_output'; runId: string; seq: number; stage: string; data: AgentOutputEvent }
//   | { type: 'run_status'; runId: string; status: WorkflowRunStatus; stage?: string }
//   | { type: 'stage_status'; runId: string; stage: string; status: StageStatus }
//   | { type: 'review_created'; reviewId: string; runId: string; stage: string }
//   | { type: 'notification'; level: 'info' | 'warning' | 'error'; message: string }
//   | { type: 'resync_required'; runId: string }

// ── Config ──

interface WebSocketConfig {
  getUrl: () => string;              // ws://localhost:<port>/ws
  getAuthToken: () => string;
  /** Initial reconnect delay in ms. Default 1000. */
  initialReconnectDelay?: number;
  /** Maximum reconnect delay in ms. Default 30000. */
  maxReconnectDelay?: number;
  /** Max reconnect attempts before giving up. Default 10. */
  maxReconnectAttempts?: number;
}

// ── State ──

type WebSocketState = 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';

// ── Manager ──

class WebSocketManager {
  private ws: WebSocket | null = null;
  private state: WebSocketState = 'closed';
  private shouldReconnect = true;     // false on intentional disconnect()
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, number>();  // runId → lastSeq
  private listeners = new Map<string, Set<(msg: ServerMessage) => void>>();

  constructor(private config: WebSocketConfig) {}

  /** Open connection. Authenticates via query param (SAD §6.1). */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.state = 'connecting';
    this.shouldReconnect = true;  // reset on every intentional connect
    const url = `${this.config.getUrl()}?token=${this.config.getAuthToken()}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.state = 'open';
      this.reconnectAttempts = 0;
      this.resubscribeAll();
      this.emit('_connection', { type: 'connected' } as any);
    };

    this.ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      this.dispatch(msg);
    };

    this.ws.onclose = () => {
      this.state = 'closed';
      this.emit('_connection', { type: 'disconnected' } as any);
      if (this.shouldReconnect) {
        this.attemptReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  /** Close connection permanently (app shutdown or intentional port change). */
  disconnect(): void {
    this.shouldReconnect = false;  // prevent onclose from triggering reconnect
    this.state = 'closing';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Reconnect to a new URL (e.g., after daemon restart on a different port).
   * Disconnects the old WS cleanly, updates config, and connects fresh.
   */
  reconnectToNewUrl(getUrl: () => string, getAuthToken: () => string): void {
    this.disconnect();
    this.config = { ...this.config, getUrl, getAuthToken };
    this.reconnectAttempts = 0;
    this.connect();
  }

  // ── Subscriptions ──

  /** Subscribe to a run's streaming output (SAD §3.2). */
  subscribe(runId: string, lastSeq?: number): void {
    this.subscriptions.set(runId, lastSeq ?? 0);
    this.send({ type: 'subscribe', runId, lastSeq });
  }

  /** Unsubscribe from a run's stream. */
  unsubscribe(runId: string): void {
    this.subscriptions.delete(runId);
    this.send({ type: 'unsubscribe', runId });
  }

  // ── Event Listeners ──

  /** Register listener for events. Use '_global' for broadcast events. */
  on(channel: string, listener: (msg: ServerMessage) => void): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(listener);
    return () => this.listeners.get(channel)?.delete(listener);
  }

  // ── Internal ──

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private dispatch(msg: ServerMessage): void {
    // Route to run-specific listeners
    if ('runId' in msg) {
      this.emit(msg.runId, msg);

      // Track last sequence number for reconnect replay
      if (msg.type === 'run_output') {
        this.subscriptions.set(msg.runId, msg.seq);
      }
    }

    // All messages also go to global listeners
    this.emit('_global', msg);
  }

  private emit(channel: string, msg: ServerMessage): void {
    this.listeners.get(channel)?.forEach((fn) => fn(msg));
  }

  /** Resubscribe all tracked runs after reconnect with last-seen seq. */
  private resubscribeAll(): void {
    for (const [runId, lastSeq] of this.subscriptions) {
      this.send({ type: 'subscribe', runId, lastSeq });
    }
  }

  /** Exponential backoff reconnect (SAD §2.2.3). */
  private attemptReconnect(): void {
    const max = this.config.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= max) {
      this.state = 'closed';
      this.emit('_connection', { type: 'failed' } as any);
      return;
    }

    this.state = 'reconnecting';
    const baseDelay = this.config.initialReconnectDelay ?? 1000;
    const maxDelay = this.config.maxReconnectDelay ?? 30_000;
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts),
      maxDelay,
    );
    // Jitter: ±25%
    const jitter = delay * (0.75 + Math.random() * 0.5);

    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
  }
}
```

### 5.2 Event Dispatching to Zustand Stores

```typescript
// hooks/useWebSocket.ts
// Bridges WebSocket events into Zustand stores.

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../stores/workspace';
import { useStreamingStore } from '../stores/streaming';
import { useDaemonStore } from '../stores/daemon';
import { clearCachedToken, getAuthToken } from '../api/auth';
import { debouncedGetRun } from '../hooks/useDaemonApi';

/**
 * Connects WebSocket events to Zustand stores.
 * Also listens for Tauri daemon-status events (from Rust sidecar monitor)
 * to handle port changes after daemon restart.
 *
 * Mounted once at the root layout level.
 */
function useWebSocketBridge(ws: WebSocketManager, apiClient: ApiClient): void {
  const upsertRun = useWorkspaceStore((s) => s.upsertRun);
  const appendEvent = useStreamingStore((s) => s.appendEvent);
  const markResyncRequired = useStreamingStore((s) => s.markResyncRequired);
  const setDaemonStatus = useDaemonStore((s) => s.setStatus);
  const setDaemonPort = useDaemonStore((s) => s.setPort);
  const setAuthToken = useDaemonStore((s) => s.setAuthToken);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // ── Tauri sidecar events → handle port/token changes on daemon restart ──
    const unlisten = listen<DaemonEvent>('daemon-status', async (event) => {
      const payload = event.payload;

      if (payload.type === 'Connected') {
        const newPort = payload.port;
        const currentPort = useDaemonStore.getState().port;

        // Daemon may have restarted on a different port and/or regenerated
        // its auth token. Clear the cached token and re-read from disk.
        clearCachedToken();
        const newToken = await getAuthToken();

        // Update stores
        setDaemonPort(newPort);
        setAuthToken(newToken);
        setDaemonStatus('connected');

        // If port changed, reconnect WS to new URL with fresh token
        if (newPort !== currentPort) {
          ws.reconnectToNewUrl(
            () => `ws://localhost:${newPort}/ws`,
            () => newToken,
          );
          // Update API client base URL
          apiClient.updateBaseUrl(`http://localhost:${newPort}`);
        }
      } else if (payload.type === 'Disconnected') {
        setDaemonStatus('disconnected');
      } else if (payload.type === 'RestartFailed') {
        setDaemonStatus('failed');
      }
    });
    unlisten.then((fn) => unsubs.push(fn));

    // ── WS connection status → daemon store ──
    unsubs.push(
      ws.on('_connection', (msg: any) => {
        if (msg.type === 'connected') setDaemonStatus('connected');
        else if (msg.type === 'disconnected') setDaemonStatus('disconnected');
        else if (msg.type === 'failed') setDaemonStatus('failed');
      }),
    );

    // ── WS server messages → workspace + streaming stores ──
    unsubs.push(
      ws.on('_global', (msg) => {
        switch (msg.type) {
          case 'run_status':
            // Debounced: rapid WS events for the same runId are coalesced
            debouncedGetRun(apiClient, msg.runId).then((run) => {
              if (run) upsertRun(run);
            });
            break;

          case 'review_created':
            debouncedGetRun(apiClient, msg.runId).then((run) => {
              if (run) upsertRun(run);
            });
            break;

          case 'run_output':
            appendEvent(msg.runId, {
              seq: msg.seq,
              stage: msg.stage,
              data: msg.data,
              receivedAt: Date.now(),
            });
            break;

          case 'notification':
            // Show toast notification
            toast[msg.level](msg.message);
            break;

          case 'resync_required':
            markResyncRequired(msg.runId);
            break;
        }
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, [ws, apiClient]);
}
```

### 5.2.1 `useDaemonApi` — Debounced Data Fetching Hook

Rapid WS events (e.g., multiple `run_status` events within milliseconds during stage transitions) can trigger parallel `getRun` calls for the same runId. This hook deduplicates and debounces those fetches.

```typescript
// hooks/useDaemonApi.ts

const pendingFetches = new Map<string, Promise<WorkflowRunDetail | null>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce interval for coalescing rapid getRun calls per runId. */
const DEBOUNCE_MS = 200;

/**
 * Debounced getRun: if called multiple times for the same runId within
 * DEBOUNCE_MS, only the last call executes. Concurrent in-flight requests
 * for the same runId are deduplicated (return the same promise).
 */
export function debouncedGetRun(
  client: ApiClient,
  runId: string,
): Promise<WorkflowRunDetail | null> {
  // If there's already an in-flight request, return it
  const existing = pendingFetches.get(runId);
  if (existing) return existing;

  // Debounce: cancel previous timer, start new one
  const prev = debounceTimers.get(runId);
  if (prev) clearTimeout(prev);

  return new Promise((resolve) => {
    debounceTimers.set(
      runId,
      setTimeout(async () => {
        debounceTimers.delete(runId);
        const promise = client.getRun(runId).catch(() => null);
        pendingFetches.set(runId, promise);
        const result = await promise;
        pendingFetches.delete(runId);
        resolve(result);
      }, DEBOUNCE_MS),
    );
  });
}
```

### 5.3 Buffer Overflow Handling

When the daemon's per-run event buffer overflows (> 10,000 events, SAD §2.2.4), it sends `resync_required`. The GUI falls back to REST:

```typescript
// hooks/useRunStream.ts

function useRunStream(runId: string): void {
  const needsResync = useStreamingStore(
    (s) => s.buffers[runId]?.needsResync ?? false,
  );

  useEffect(() => {
    if (!needsResync) return;

    // Fall back to REST to get full conversation (SAD §2.2.4)
    apiClient.getRunMessages(runId).then((messages) => {
      useStreamingStore.getState().resyncFromRest(runId, messages);
    });
  }, [runId, needsResync]);
}
```

---

## 6. Page Components

### 6.1 Workspace (Main Page) — `pages/Workspace.tsx`

The primary view. Two-panel layout: run feed on the left, detail panel on the right.

**Layout (SAD §2.2.2):**

```
┌──────────────────────────────────────────────────────┐
│  ┌─────── 320px ─────┐  ┌─── flex-1 ──────────────┐ │
│  │  [+ New Run]       │  │                          │ │
│  │  [Filter] [Sort]   │  │  DetailPanel              │ │
│  │  ┌───────────────┐ │  │  (RunDetail | ReviewPanel │ │
│  │  │ RunCard       │ │  │   | ProposalPanel |       │ │
│  │  │ (selected ●)  │ │  │   EmptyState)            │ │
│  │  ├───────────────┤ │  │                          │ │
│  │  │ RunCard       │ │  │                          │ │
│  │  ├───────────────┤ │  │                          │ │
│  │  │ RunCard       │ │  │                          │ │
│  │  │ ...           │ │  │                          │ │
│  │  └───────────────┘ │  │                          │ │
│  └───────────────────┘  └──────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

**Data fetching:**
- Initial load: `GET /api/runs` → workspace store
- Real-time updates: WS `run_status` events → `upsertRun()`
- Selected run: `GET /api/runs/:id` → full detail with stages

**Key interactions:**
- Click run card → select run → detail panel shows RunDetail
- Click "+ New Run" → opens NewRunModal
- Filter by status chips, project dropdown, search text
- Sort by created, updated, or status
- Right-click run → "Open in New Window" (Tauri popout)

### 6.2 Projects Page — `pages/Projects.tsx`

CRUD interface for registered git repositories (SRD §2.1).

**Layout:** Card grid of registered projects + "Add Project" button.

**Data fetching:** `GET /api/projects`

**Key interactions:**
- Add project: folder picker (Tauri dialog) → validate git repo → `POST /api/projects`
- Edit project: inline edit name/description, credential set dropdown
- Delete project: confirmation dialog → `DELETE /api/projects/:id`
- View branches: expandable branch list per project

```typescript
interface ProjectCardProps {
  project: Project;
  onEdit: (project: Project) => void;
  onDelete: (projectId: string) => void;
}
```

### 6.3 Workflows (Template Editor) Page — `pages/Workflows.tsx`

Template management (SRD §2.4 FR-W1, FR-W12).

**Layout:** Template list (left) + stage editor (right).

**Data fetching:** `GET /api/workflows`

**Key interactions:**
- Create template: name + description + stage builder
- Edit template: add/remove/reorder stages, edit stage prompts
- Stage editor fields: name, type (standard/split), prompt template, reviewRequired/autoAdvance toggle, freshSession toggle
- Delete template: confirmation, blocks if used by active runs

```typescript
interface StageEditorProps {
  stages: WorkflowStageInput[];
  onChange: (stages: WorkflowStageInput[]) => void;
}
```

### 6.4 Credentials Page — `pages/Credentials.tsx`

Credential vault management (SRD §2.7). Values are never shown in plaintext (FR-C7).

**Layout:** Credential set list + entry editor per set.

**Data fetching:** `GET /api/credentials`

**Key interactions:**
- Create set: name, optional project scope
- Add entry: type selector → type-specific form (env var key/value, file mount path/content, etc.)
- Values displayed as `•••••••` — no "reveal" button (security by design)
- Delete entry/set: confirmation dialog

```typescript
interface CredentialEntryFormProps {
  type: CredentialEntryType;
  onSubmit: (data: CreateCredentialEntryInput) => void;
  onCancel: () => void;
}

type CredentialEntryType =
  | 'env_var'
  | 'file_mount'
  | 'docker_login'
  | 'host_dir_mount'
  | 'command_extract';
```

### 6.5 Settings Page — `pages/Settings.tsx`

Agent definitions (SRD §2.2) and app preferences.

**Layout:** Tabbed interface — "Agents" | "Preferences".

**Agents tab:** CRUD for agent definitions with capability toggles.

**Preferences tab:** Dark mode toggle (future), data retention settings, daemon management (stop/restart).

```typescript
interface AgentFormProps {
  agent?: AgentDefinition;       // undefined for create
  onSubmit: (data: CreateAgentInput) => void;
  onCancel: () => void;
}
```

---

## 7. Core Components

### 7.1 Run Components

#### `RunFeed` — Filterable Workflow Run List

```typescript
interface RunFeedProps {
  /** Currently selected run ID (highlighted in list). */
  selectedRunId: string | null;
  /** Callback when a run is clicked. */
  onSelectRun: (runId: string) => void;
  /** Callback to open New Run modal. */
  onNewRun: () => void;
}

// Internal state: uses workspace store for runs, filters, sort.
// Renders a virtualized list (TanStack Virtual) of RunCard components.
// Filter bar: status chip group + project dropdown + search input.
// Sort: dropdown with createdAt | updatedAt | status.
```

#### `RunCard` — Single Run in Feed

```typescript
interface RunCardProps {
  run: WorkflowRun;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;  // right-click → popout menu
}

// Displays:
// - StatusBadge (left)
// - Title (truncated) + project name
// - Current stage name + progress indicator
// - Relative timestamp ("2m ago")
// - Streaming activity indicator (pulsing dot when live)
```

#### `RunDetail` — Full Run View

```typescript
interface RunDetailProps {
  runId: string;
}

// Data fetching: GET /api/runs/:id → stages, review, parallel group
// WebSocket: subscribe to runId stream on mount, unsubscribe on unmount
//
// Layout (tabbed):
// ┌────────────────────────────────────────────┐
// │  Run Title                    [Actions ▾]  │
// │  project / branch             StatusBadge  │
// ├────────────────────────────────────────────┤
// │  StageTimeline (horizontal pipeline)       │
// ├────────────────────────────────────────────┤
// │  [Conversation] [Review] [Details]  tabs   │
// │  ┌──────────────────────────────────────┐  │
// │  │  Tab content:                        │  │
// │  │  - Conversation: RunConversation     │  │
// │  │  - Review: ReviewPanel               │  │
// │  │  - Details: run metadata, stats      │  │
// │  └──────────────────────────────────────┘  │
// │  ┌──────────────────────────────────────┐  │
// │  │  InterventionInput (when running)    │  │
// │  └──────────────────────────────────────┘  │
// └────────────────────────────────────────────┘
//
// Actions menu (context-dependent):
// - Running: Cancel, Send Message
// - stage_failed: Retry, Skip, Cancel
// - awaiting_review: (actions in ReviewPanel)
// - awaiting_proposals: (actions in ProposalPanel)
// - awaiting_conflict_resolution: Resolve Conflict, Cancel
// - Terminal: Delete, Open in New Window
```

#### `RunConversation` — Continuous Conversation View

```typescript
interface RunConversationProps {
  runId: string;
}

// Data sources:
// 1. REST: GET /api/runs/:id/messages → full conversation history
// 2. WS: run_output events → append live streaming content
//
// Renders the complete agent session log (FR-W19):
// - User messages (prompts, interventions, review comments)
// - Assistant messages (Streamdown-rendered markdown)
// - Tool calls (collapsible: name + args + result)
// - Agent thoughts (collapsible, dimmed)
// - System messages (stage transitions, session boundaries)
// - Session boundaries (visual divider when freshSession occurs)
//
// Streaming behavior:
// - Live assistant messages render incrementally via Streamdown
// - Auto-scroll to bottom when new content arrives (unless user scrolled up)
// - Virtualized rendering for long conversations (TanStack Virtual)
//
// Session boundaries rendered as:
// ┌─── Session 2: "implement" stage ────────────────────┐
// │  New session started (fresh context)                 │
// └─────────────────────────────────────────────────────┘
```

#### `InterventionInput` — Send Message to Running Agent

```typescript
interface InterventionInputProps {
  runId: string;
  disabled: boolean;     // true when run is not in 'running' status
}

// Single-line input with Send button.
// Calls POST /api/runs/:id/message (FR-W21).
// Clears on successful send.
// Disabled with tooltip when run is not actively executing.
```

#### `StageTimeline` — Visual Pipeline

> **Note:** SAD §2.2.1 lists this component as `StageVisualization.tsx`. Renamed to `StageTimeline` in the CDD to better describe the horizontal pipeline UI pattern. The file will be `components/run/StageTimeline.tsx`.

```typescript
interface StageTimelineProps {
  stages: StageExecution[];
  templateStages: WorkflowStage[];    // from workflow template
  currentStage: string | null;
}

// Horizontal pipeline visualization:
//   [plan ✓] ──→ [implement ●] ──→ [review ○] ──→ [commit ○]
//
// Each node shows:
// - Stage name
// - Status icon: ✓ completed, ● running (animated), ✕ failed, ○ pending, ⊘ skipped
// - Round indicator (e.g., "R2" if on round 2 after request_changes)
// - Click to scroll conversation to that stage's messages
// - For split stages: fan-out visualization showing child count
```

#### `NewRunModal` — Workflow Run Creation

```typescript
interface NewRunModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (runId: string) => void;
}

// Form fields:
// 1. Project selector (dropdown, required) — GET /api/projects
// 2. Workflow template (dropdown, required) — GET /api/workflows
//    "Quick Run" pre-selected for convenience
// 3. Description (textarea, required) — the run prompt
// 4. Base branch (dropdown, optional) — GET /api/projects/:id/branches
//    Default: current checked-out branch
// 5. Target branch (text input, optional) — default: same as base
// 6. Credential set (dropdown, optional) — GET /api/credentials
//    Shows project-scoped sets + global sets
// 7. Agent (dropdown, optional) — GET /api/agents
//    Default: first available agent
//
// Remembers last config via GET /api/stats (lastRunConfig).
// Submit: POST /api/runs → navigate to new run.
```

### 7.2 Review Components

#### `ReviewPanel` — Diff + Comments + Actions

```typescript
interface ReviewPanelProps {
  reviewId: string;
  runId: string;
}

// Data fetching: GET /api/reviews/:id (includes diff, comments, summary)
//
// Layout:
// ┌────────────────────────────────────────────┐
// │  ReviewHeader                              │
// │  (round selector, status, approve/reject)  │
// ├────────────────────────────────────────────┤
// │  AI Summary (collapsible markdown)         │
// ├────────────────────────────────────────────┤
// │  Plan.md (collapsible, if captured)        │
// ├────────────────────────────────────────────┤
// │  ┌─── FileTree ────┐  ┌─── DiffViewer ──┐ │
// │  │  src/auth.ts  +5 │  │  unified diff   │ │
// │  │  src/login.ts -3 │  │  with inline    │ │
// │  │  ...             │  │  comments       │ │
// │  └─────────────────┘  └─────────────────┘ │
// │  ┌──────────────────────────────────────┐  │
// │  │  General Comment Input               │  │
// │  └──────────────────────────────────────┘  │
// └────────────────────────────────────────────┘
//
// Actions:
// - Approve: POST /api/reviews/:id/approve → advances workflow
// - Request Changes: POST /api/reviews/:id/request-changes
//   (must have ≥1 comment to request changes)
```

#### `DiffViewer` — File Diff Display

```typescript
interface DiffViewerProps {
  files: DiffFile[];
  selectedFile: string | null;
  comments: ReviewComment[];
  onAddComment: (data: CreateCommentInput) => void;
  readOnly?: boolean;           // true for completed reviews
}

// Unified diff view (NFR-U5).
// Renders hunks with line numbers, +/- coloring.
// Click gutter to add inline comment at that line.
// Existing comments rendered inline below their target line.
//
// Implementation: custom renderer using DiffFile/DiffHunk/DiffLine types.
// No external diff library needed — daemon provides pre-parsed diff.
//
// Performance: virtualized rendering for large diffs (files with 1000+ lines).
```

#### `FileTree` — Navigable File List

```typescript
interface FileTreeProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

// Flat file list grouped by directory.
// Each entry shows: filename, status icon (A/M/D/R), +/- line counts.
// Click to scroll DiffViewer to that file.
// Sorted: directories first, then alphabetical.
```

#### `InlineComment` — Per-Line Comment

```typescript
interface InlineCommentProps {
  comment: ReviewComment;
  onDelete?: (commentId: string) => void;   // only for own comments
}

// Rendered inline within the diff view, below the target line.
// Shows comment body (markdown-rendered), timestamp.
// Delete button for comments not yet submitted (pending changes).
```

#### `ReviewHeader` — Round Selector + Status + Actions

```typescript
interface ReviewHeaderProps {
  review: Review;
  reviews: Review[];           // all rounds for this stage
  selectedRound: number;
  onSelectRound: (round: number) => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  canApprove: boolean;         // true if review is pending
  canRequestChanges: boolean;  // true if ≥1 comment exists
}

// Shows:
// - Review status badge (pending_review / approved / changes_requested)
// - Round selector: [R1] [R2] [R3] (navigate between review rounds, FR-R9)
// - Approve button (green, primary)
// - Request Changes button (orange, requires comments)
// - Stage name + run title context
```

### 7.3 Workflow Components

#### `ProposalPanel` — Split Proposal Editor

```typescript
interface ProposalPanelProps {
  runId: string;
  proposals: Proposal[];
  onLaunch: (proposalIds: string[]) => void;
}

// Displays proposals generated by a split stage (SRD §2.5).
//
// Layout:
// ┌────────────────────────────────────────────┐
// │  "Review Proposals" heading                │
// │  ┌──────────────────────────────────────┐  │
// │  │  ☑ Proposal 1: "Extract auth module" │  │
// │  │    Description (editable textarea)   │  │
// │  │    Files: src/auth.ts, src/login.ts  │  │
// │  │    Template: [Quick Run ▾]           │  │
// │  ├──────────────────────────────────────┤  │
// │  │  ☑ Proposal 2: "Add unit tests"     │  │
// │  │    ...                               │  │
// │  ├──────────────────────────────────────┤  │
// │  │  ☐ Proposal 3: "Update docs"        │  │
// │  │    (unchecked — will not launch)     │  │
// │  └──────────────────────────────────────┘  │
// │  [+ Add Proposal]  [Launch Selected (2)]   │
// └────────────────────────────────────────────┘
//
// Interactions:
// - Check/uncheck proposals for launch
// - Edit proposal title, description, affected files
// - Change workflow template override per proposal
// - Drag-and-drop reorder (sets sortOrder for merge order, FR-S9)
// - Add custom proposal
// - Discard proposal (sets status: 'discarded')
// - "Launch Selected" → POST /api/proposals/launch
```

#### `ParallelGroupStatus` — Children Progress

```typescript
interface ParallelGroupStatusProps {
  group: ParallelGroupDetail;
}

// Shows progress of parallel child workflow runs.
//
// Layout:
// ┌──────────────────────────────────────────────┐
// │  Parallel Execution: 2/3 completed           │
// │  ┌───────┐ ┌───────┐ ┌───────┐              │
// │  │ ✓ Auth│ │ ● Test│ │ ✕ Docs│              │
// │  │ done  │ │ run.. │ │ fail  │              │
// │  └───────┘ └───────┘ └───────┘              │
// │  [Consolidate Completed] [Retry Failed]      │
// └──────────────────────────────────────────────┘
//
// Click a child card to navigate to its run detail.
// Actions depend on group status:
// - children_completed: [Consolidate]
// - children_mixed: [Consolidate Completed] [Retry Failed] [Cancel]
// - consolidating: spinner
```

### 7.4 Shared Components

#### `StatusBadge` — Status Indicator

```typescript
interface StatusBadgeProps {
  status: WorkflowRunStatus | StageStatus | ReviewStatus | ParallelGroupStatus;
  size?: 'sm' | 'md' | 'lg';        // default: 'md'
  showLabel?: boolean;               // default: true
}

// Color mapping (exhaustive for all status enums from SAD §4.3):
const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
  // WorkflowRunStatus
  pending:           { bg: 'bg-muted',        text: 'text-muted-foreground', dot: 'bg-gray-400' },
  provisioning:      { bg: 'bg-blue-950',     text: 'text-blue-400',        dot: 'bg-blue-400' },
  running:           { bg: 'bg-green-950',     text: 'text-green-400',       dot: 'bg-green-400 animate-pulse' },
  stage_failed:      { bg: 'bg-red-950',       text: 'text-red-400',         dot: 'bg-red-400' },
  awaiting_review:   { bg: 'bg-yellow-950',    text: 'text-yellow-400',      dot: 'bg-yellow-400' },
  awaiting_proposals:{ bg: 'bg-purple-950',    text: 'text-purple-400',      dot: 'bg-purple-400' },
  waiting_for_children: { bg: 'bg-indigo-950', text: 'text-indigo-400',      dot: 'bg-indigo-400 animate-pulse' },
  children_completed_with_failures: { bg: 'bg-orange-950', text: 'text-orange-400', dot: 'bg-orange-400' },
  awaiting_conflict_resolution: { bg: 'bg-amber-950', text: 'text-amber-400', dot: 'bg-amber-400' },
  finalizing:        { bg: 'bg-cyan-950',      text: 'text-cyan-400',        dot: 'bg-cyan-400 animate-pulse' },
  completed:         { bg: 'bg-green-950',     text: 'text-green-400',       dot: 'bg-green-400' },
  failed:            { bg: 'bg-red-950',       text: 'text-red-400',         dot: 'bg-red-400' },
  cancelled:         { bg: 'bg-muted',         text: 'text-muted-foreground', dot: 'bg-gray-500' },
  // ReviewStatus
  pending_review:    { bg: 'bg-yellow-950',    text: 'text-yellow-400',      dot: 'bg-yellow-400' },
  approved:          { bg: 'bg-green-950',     text: 'text-green-400',       dot: 'bg-green-400' },
  changes_requested: { bg: 'bg-orange-950',    text: 'text-orange-400',      dot: 'bg-orange-400' },
  // StageStatus
  skipped:           { bg: 'bg-muted',         text: 'text-muted-foreground', dot: 'bg-gray-500' },
  // ParallelGroupStatus (SAD §4.3)
  children_completed:{ bg: 'bg-blue-950',      text: 'text-blue-400',        dot: 'bg-blue-400' },
  children_mixed:    { bg: 'bg-amber-950',     text: 'text-amber-400',       dot: 'bg-amber-400' },
  consolidating:     { bg: 'bg-purple-950',    text: 'text-purple-400',      dot: 'bg-purple-400 animate-pulse' },
};
```

#### `CommandPalette` — ⌘K Search (NFR-U3)

```typescript
interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

// Built on cmdk library.
// Sections:
// 1. "Runs" — search workflow runs by title/description
// 2. "Projects" — navigate to project
// 3. "Actions" — New Run, New Project, Settings, etc.
//
// Data: pulls from workspace store (runs, projects).
// Selection: navigate to run detail or project page.
// Keyboard: ⌘K to open, Escape to close, arrow keys + Enter to select.
```

#### `DaemonStatus` — Connection Indicator (NFR-U6)

```typescript
interface DaemonStatusProps {}  // reads from daemon store

// Renders based on daemon store status:
// - 'connected': green dot (hidden in normal flow, shown in sidebar footer)
// - 'connecting': spinner + "Connecting to daemon..."
// - 'disconnected': yellow banner at top of layout:
//     "⚠ Daemon disconnected. Reconnecting..."
// - 'reconnecting': yellow banner with attempt count:
//     "⚠ Reconnecting (attempt 3/10)..."
// - 'failed': red banner:
//     "✕ Cannot reach daemon. [Restart] [Settings]"
//
// Banner is rendered in RootLayout, above <Outlet />.
```

#### `PrerequisiteCheck` — First-Launch Setup Guide (NFR-I4)

```typescript
interface PrerequisiteCheckProps {
  results: PrerequisiteResult[];
  onRecheck: () => void;
  onDismiss: () => void;
}

// Full-page overlay shown when any prerequisite check fails.
// Shows each check with status icon and fix instructions:
//
// ┌────────────────────────────────────────────┐
// │  🔧 Setup Required                        │
// │                                            │
// │  ✓ Docker installed                        │
// │  ✓ Docker running                          │
// │  ✕ docker sandbox not available            │
// │    → Install Docker Desktop 4.x+ with      │
// │      sandbox support enabled               │
// │  ✓ Git installed                           │
// │  ⚠ GitHub auth not configured              │
// │    → Run: gh auth login                    │
// │                                            │
// │  [Re-check]  [Skip (advanced)]             │
// └────────────────────────────────────────────┘
//
// Calls GET /api/prerequisites on mount and on "Re-check".
// Dismissible for advanced users who know what they're doing.
```

---

## 8. Streaming Integration

### 8.1 Streamdown Integration

[Streamdown](https://github.com/anthropics/streamdown) renders markdown from incomplete streaming chunks, handling unclosed bold, partial code blocks, and unterminated links (NFR-U4).

**Key design decision:** Streamdown is used **only for the actively-streaming tail message** (the current incomplete assistant response). All finalized messages are rendered as static markdown using a lightweight markdown renderer (e.g., `react-markdown`). This avoids creating Streamdown instances for every historical message and reduces memory usage.

```typescript
// components/run/StreamdownRenderer.tsx

import { useRef, useEffect } from 'react';
import Streamdown from 'streamdown';

interface StreamdownRendererProps {
  /** Raw markdown text (may be incomplete during streaming). */
  content: string;
  /** True if content is still being streamed. */
  isStreaming: boolean;
}

/**
 * Renders streaming markdown using Streamdown's incremental DOM output.
 *
 * Streamdown outputs DOM nodes directly — we attach them to a ref-based
 * container, bypassing React's virtual DOM for streaming performance.
 * A new Streamdown instance is created per streaming message and destroyed
 * when the message finalizes (isStreaming → false).
 */
function StreamdownRenderer({ content, isStreaming }: StreamdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const streamdownRef = useRef<Streamdown | null>(null);
  const lastLengthRef = useRef(0);

  // Create Streamdown instance when streaming starts
  useEffect(() => {
    if (isStreaming && !streamdownRef.current && containerRef.current) {
      streamdownRef.current = new Streamdown({
        target: containerRef.current,
        theme: 'dark',
      });
      lastLengthRef.current = 0;
    }

    // Cleanup: destroy instance when streaming ends or component unmounts
    return () => {
      if (!isStreaming && streamdownRef.current) {
        streamdownRef.current.finish();
        streamdownRef.current = null;
      }
    };
  }, [isStreaming]);

  // Feed new chunks to Streamdown as content grows
  useEffect(() => {
    if (streamdownRef.current && content.length > lastLengthRef.current) {
      const newChunk = content.slice(lastLengthRef.current);
      streamdownRef.current.push(newChunk);
      lastLengthRef.current = content.length;
    }
  }, [content]);

  // Finalize on stream end
  useEffect(() => {
    if (!isStreaming && streamdownRef.current) {
      streamdownRef.current.finish();
      streamdownRef.current = null;
    }
  }, [isStreaming]);

  // During streaming: Streamdown writes directly to containerRef
  // After streaming ends: fall through to static markdown (handled by parent)
  return <div ref={containerRef} className="streamdown-container" />;
}
```

**Usage in RunConversation:**

```typescript
// In VirtualizedConversation, the streaming tail is rendered separately:
//
// 1. Finalized assistant_message blocks → <StaticMarkdown content={...} />
//    (uses react-markdown, no Streamdown overhead)
//
// 2. streamingTail (from streaming store) → <StreamdownRenderer
//      content={tail.content} isStreaming={true} />
//    (only ONE instance exists at any time — the current live message)
//
// When the agent finishes the message (tool_call starts, or result arrives),
// the transform layer finalizes the tail into an assistant_message block,
// clears streamingTail, and the StreamdownRenderer unmounts.
```

### 8.2 Chunking & Virtualization

Long agent outputs (thousands of tool calls, extensive reasoning) require virtualization to maintain GUI responsiveness (NFR-P3).

```typescript
// components/run/VirtualizedConversation.tsx

interface VirtualizedConversationProps {
  messages: RunMessage[];
  streamingContent?: string;    // live streaming tail
  isStreaming: boolean;
}

// Strategy:
// 1. Group messages into "blocks" (a block = one assistant turn, one tool call, etc.)
// 2. Use TanStack Virtual to render only visible blocks
// 3. Each block estimates its own height (based on content length)
// 4. Streaming tail (current assistant message) is always rendered outside
//    the virtualized container to avoid flicker from height recalculations
//
// Block types:
// - UserMessage: prompt text, stage annotation
// - AssistantMessage: Streamdown-rendered markdown
// - ToolCall: collapsible panel (name + args + result)
// - AgentThought: collapsible, dimmed italic
// - SystemMessage: stage transition, session boundary
// - InterventionMessage: user intervention (highlighted differently)
//
// Auto-scroll: scroll to bottom on new content UNLESS user has scrolled up.
// "Jump to bottom" floating button when not at bottom.
```

### 8.3 Session Boundary Rendering

When `freshSession: true` creates a new ACP session within a run, a visual boundary is rendered in the conversation:

```typescript
interface SessionBoundaryProps {
  sessionIndex: number;
  stageName: string;
  timestamp: string;
  isFreshSession: boolean;
}

// Renders as a full-width divider:
// ────────── Session 2 · "implement" stage · 2:34 PM ──────────
//            New session (fresh context)
//
// Context injection is shown as a system message block below the boundary,
// containing the injected prior context (plan.md, review summary, etc.).
```

---

## 9. Multi-Window Support

### 9.1 Pop-Out Button Component

```typescript
interface PopOutButtonProps {
  /** Route to open in the new window. Uses pop-out route format. */
  route: string;
  /** Window title. */
  title: string;
  /** Tooltip text. Default: "Open in new window". */
  tooltip?: string;
}

// Renders a small icon button (external-link icon).
// On click: invokes Tauri command to create a new WebviewWindow.
// Available on: RunDetail header, ReviewPanel header, streaming output.
```

**Pop-out route definitions:**

Pop-out windows use dedicated routes that render only the content (no sidebar). These are separate from the main app routes to allow independent layout:

```typescript
// routes (added to router.ts)

// Pop-out: full run detail (conversation + stages + review)
const popoutRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/run/$runId',
  component: PopoutRunDetail,
});

// Pop-out: specific review for a run
const popoutReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/run/$runId/review/$reviewId',
  component: PopoutReviewPanel,
});

// Pop-out: specific stage conversation
const popoutStageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/run/$runId/stage/$stageName',
  component: PopoutStageConversation,
});

// Pop-out components render their content in a minimal layout
// (no sidebar, no navigation — just the content + DaemonStatus banner).
// They use the same core components (RunDetail, ReviewPanel, etc.)
// but wrapped in a PopoutLayout shell.
```

### 9.2 Window Creation via Tauri API

```typescript
// lib/window.ts
import { invoke } from '@tauri-apps/api/core';

/**
 * Open a route in a new OS window (SAD §2.2.2).
 * Each window gets its own Zustand stores and WebSocket connection.
 */
async function openPopoutWindow(route: string, title: string): Promise<void> {
  await invoke('open_popout_window', { route, title });
}

// Rust side (lib.rs) creates the window:
// WebviewWindowBuilder::new(&app, window_label, tauri::WebviewUrl::App(route))
//   .title(title)
//   .inner_size(1024.0, 768.0)
//   .min_inner_size(600.0, 400.0)
//   .build()?;
```

### 9.3 Independent Store Hydration

Each Tauri window is a separate webview with its own JavaScript context (SAD §2.2.2). No cross-window shared state — the daemon is the consistency layer.

**Pop-out bootstrap race prevention:** Pop-out windows must NOT call `start_daemon()` — that could race with the main window's sidecar monitor. Instead, pop-outs read the daemon port from Tauri app state (set by the main window's `start_daemon` and `monitor_daemon`). The main window is always responsible for sidecar lifecycle.

```typescript
// main.tsx (runs in every window, including pop-outs)

/** Check if this is a pop-out window (route starts with /run/). */
function isPopoutWindow(): boolean {
  return window.location.pathname.startsWith('/run/');
}

async function bootstrap(): Promise<void> {
  let port: number;
  let authToken: string;

  if (isPopoutWindow()) {
    // Pop-out: read daemon port from Tauri app state (set by main window).
    // Do NOT call start_daemon() — the main window manages the sidecar.
    port = await invoke<number>('get_daemon_port');
    authToken = await invoke<string>('read_auth_token');
  } else {
    // Main window: start daemon sidecar if needed, get port
    const daemonInfo = await invoke<DaemonInfo>('start_daemon');
    port = daemonInfo.port;
    authToken = await invoke<string>('read_auth_token');
  }

  // 2. Initialize API client
  const client = new ApiClient({
    getBaseUrl: () => `http://localhost:${useDaemonStore.getState().port ?? port}`,
    getAuthToken: () => useDaemonStore.getState().authToken ?? authToken,
  });

  // Store initial values
  useDaemonStore.getState().setPort(port);
  useDaemonStore.getState().setAuthToken(authToken);

  // 3. Initialize WebSocket
  const ws = new WebSocketManager({
    getUrl: () => `ws://localhost:${useDaemonStore.getState().port ?? port}/ws`,
    getAuthToken: () => useDaemonStore.getState().authToken ?? authToken,
  });

  // 4. Determine initial route
  const route = window.location.pathname;

  // 5. Hydrate stores from REST
  if (route === '/' || route.startsWith('/workspace')) {
    const runs = await client.listRuns();
    useWorkspaceStore.getState().setRuns(runs);

    // Restore last-viewed run (NFR-U8)
    const lastRunId = localStorage.getItem('vibe-harness:lastViewedRunId');
    if (lastRunId) {
      useWorkspaceStore.getState().selectRun(lastRunId);
    }
  }

  // If this is a run detail (main or pop-out), subscribe to stream
  const runIdMatch = route.match(/(?:\/workspace\/|\/run\/)([^/]+)/);
  if (runIdMatch) {
    const runId = runIdMatch[1];
    useWorkspaceStore.getState().selectRun(runId);
    ws.subscribe(runId);

    // Fetch full conversation
    const messages = await client.getRunMessages(runId);
    useStreamingStore.getState().setConversation(runId, messages);
  }

  // 6. Connect WebSocket
  ws.connect();

  // 7. Check prerequisites on main window only
  if (route === '/' && !isPopoutWindow()) {
    useDaemonStore.getState().setPrerequisitesLoading(true);
    const prereqs = await client.prerequisites();
    useDaemonStore.getState().setPrerequisites(prereqs);
    useDaemonStore.getState().setPrerequisitesLoading(false);
  }

  // 8. Render React app
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <AppProviders client={client} ws={ws}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}

bootstrap();
```

**Key guarantees (SAD §2.2.2):**
- Each window establishes its own WS connection → both see the same events
- Closing a pop-out window has no effect on the daemon or other windows
- Global notifications (workflow_status, review_created) broadcast to ALL connected WS clients
- Run-specific output events go to all windows subscribed to that runId

---

## 10. Keyboard Shortcuts (NFR-U2)

```typescript
// hooks/useKeyboardShortcuts.ts

interface ShortcutMap {
  'mod+k': () => void;          // Open command palette
  'mod+n': () => void;          // New run
  'mod+shift+n': () => void;    // New project
  'j': () => void;              // Next run in feed
  'k': () => void;              // Previous run in feed
  'Enter': () => void;          // Open selected run
  'mod+Enter': () => void;      // Approve review (when in review panel)
  'Escape': () => void;         // Close modal / deselect
  'mod+.': () => void;          // Open in new window
}

// 'mod' = ⌘ on macOS, Ctrl on Linux.
// Shortcuts are context-aware: 'j'/'k' only work when run feed is focused.
// 'mod+Enter' only works when a review panel is visible.
```

---

## 11. Traceability

| SRD Requirement | CDD Section |
|-----------------|-------------|
| NFR-U1 Multi-window | §9 Multi-Window Support |
| NFR-U2 Keyboard shortcuts | §10 Keyboard Shortcuts |
| NFR-U3 Command palette | §7.4 CommandPalette |
| NFR-U4 Streaming markdown | §8.1 Streamdown Integration |
| NFR-U5 Unified diff view | §7.2 DiffViewer |
| NFR-U6 Daemon status + reconnect | §5 WebSocket Manager, §7.4 DaemonStatus |
| NFR-U7 Daemon discovery via port file | §1.1 Sidecar Management |
| NFR-U8 Restore last-viewed run | §3.1 WorkspaceStore (localStorage persistence), §9.3 Bootstrap |
| NFR-P1 < 100ms streaming latency | §8 Streaming Integration |
| NFR-P3 GUI responsiveness | §8.2 Virtualization |
| NFR-I3 Auto-start daemon | §1.1 Sidecar Management |
| NFR-I4 Prerequisite checks | §7.4 PrerequisiteCheck |
| NFR-S1 Auth token | §4.3 Auth Token Management |
| FR-W16 Execution history | §7.1 RunDetail, StageTimeline |
| FR-W19 Session log | §7.1 RunConversation |
| FR-W20 Streaming output | §8 Streaming Integration |
| FR-W21 Interventions | §7.1 InterventionInput |
| FR-R3 File tree diff | §7.2 FileTree, DiffViewer |
| FR-R4 Inline comments | §7.2 InlineComment |
| FR-R9 Round navigation | §7.2 ReviewHeader |
| FR-S3 Proposal editing | §7.3 ProposalPanel |
| FR-D1–D3 Dashboard | §6.1 Workspace, §3.1 WorkspaceStore |
