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

**Tauri commands exposed to frontend:**

```rust
/// Start the daemon sidecar if not already running.
/// Returns the daemon port once ready.
///
/// Lifecycle (SAD §2.2.3):
///   1. Check daemon.pid — if alive, read daemon.port and return
///   2. Spawn sidecar: `Command::new_sidecar("daemon")`
///   3. Poll ~/.vibe-harness/daemon.port every 200ms, timeout 30s
///   4. HTTP GET http://localhost:<port>/health — confirm ready
///   5. Return port
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
```

**Daemon crash detection & restart:**

```rust
// Spawned as a background task after initial sidecar start
async fn monitor_daemon(app: AppHandle, port: u16) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        match check_daemon_health(port).await {
            Ok(_) => continue,
            Err(_) => {
                // Daemon unreachable — emit event to frontend
                app.emit("daemon-status", DaemonEvent::Disconnected).ok();
                // Attempt restart
                match start_daemon(app.clone()).await {
                    Ok(info) => {
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

// ── Selectors ──

/** Returns runs matching current filters, sorted by current sort config. */
function useFilteredRuns(): WorkflowRun[] {
  return useWorkspaceStore((state) => {
    let runs = state.runs;

    // Apply filters
    if (state.filters.status) {
      runs = runs.filter((r) => state.filters.status!.includes(r.status));
    }
    if (state.filters.projectId) {
      runs = runs.filter((r) => r.projectId === state.filters.projectId);
    }
    if (state.filters.searchText) {
      const q = state.filters.searchText.toLowerCase();
      runs = runs.filter(
        (r) =>
          r.title?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q)
      );
    }

    // Apply sort
    const { field, direction } = state.sort;
    runs = [...runs].sort((a, b) => {
      const av = a[field] ?? '';
      const bv = b[field] ?? '';
      return direction === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

    return runs;
  });
}
```

### 3.2 `stores/streaming.ts` — Per-Run Output Buffer

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

// ── Store Shape ──

interface StreamingState {
  // Per-run buffers (Map<runId, buffer>)
  buffers: Record<string, RunStreamBuffer>;

  // Conversation history (fetched from REST, augmented by stream)
  conversations: Record<string, RunMessage[]>;

  // Session boundaries for rendering
  sessionBoundaries: Record<string, SessionBoundary[]>;

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

```typescript
import type {
  ClientMessage,
  ServerMessage,
  WorkflowRunStatus,
  StageStatus,
  AgentOutputEvent,
} from '@vibe-harness/shared';

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
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, number>();  // runId → lastSeq
  private listeners = new Map<string, Set<(msg: ServerMessage) => void>>();

  constructor(private config: WebSocketConfig) {}

  /** Open connection. Authenticates via query param (SAD §6.1). */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.state = 'connecting';
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
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  /** Close connection permanently (app shutdown). */
  disconnect(): void {
    this.state = 'closing';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
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
import { useWorkspaceStore } from '../stores/workspace';
import { useStreamingStore } from '../stores/streaming';
import { useDaemonStore } from '../stores/daemon';

/**
 * Connects WebSocket events to Zustand stores.
 * Mounted once at the root layout level.
 */
function useWebSocketBridge(ws: WebSocketManager): void {
  const upsertRun = useWorkspaceStore((s) => s.upsertRun);
  const appendEvent = useStreamingStore((s) => s.appendEvent);
  const markResyncRequired = useStreamingStore((s) => s.markResyncRequired);
  const setDaemonStatus = useDaemonStore((s) => s.setStatus);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // Connection status → daemon store
    unsubs.push(
      ws.on('_connection', (msg: any) => {
        if (msg.type === 'connected') setDaemonStatus('connected');
        else if (msg.type === 'disconnected') setDaemonStatus('disconnected');
        else if (msg.type === 'failed') setDaemonStatus('failed');
      }),
    );

    // Global events → workspace store
    unsubs.push(
      ws.on('_global', (msg) => {
        switch (msg.type) {
          case 'run_status':
            // Fetch updated run data and upsert
            apiClient.getRun(msg.runId).then((run) => upsertRun(run));
            break;

          case 'review_created':
            // Refresh run to pick up new review
            apiClient.getRun(msg.runId).then((run) => upsertRun(run));
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

          case 'resync_required' as any:
            markResyncRequired((msg as any).runId);
            break;
        }
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, [ws]);
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

// Color mapping:
const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
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
  // Review statuses
  pending_review:    { bg: 'bg-yellow-950',    text: 'text-yellow-400',      dot: 'bg-yellow-400' },
  approved:          { bg: 'bg-green-950',     text: 'text-green-400',       dot: 'bg-green-400' },
  changes_requested: { bg: 'bg-orange-950',    text: 'text-orange-400',      dot: 'bg-orange-400' },
  // Stage statuses
  skipped:           { bg: 'bg-muted',         text: 'text-muted-foreground', dot: 'bg-gray-500' },
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

```typescript
// components/run/StreamdownRenderer.tsx

interface StreamdownRendererProps {
  /** Raw markdown text (may be incomplete during streaming). */
  content: string;
  /** True if content is still being streamed. */
  isStreaming: boolean;
}

// Uses Streamdown's incremental rendering:
// 1. Create a Streamdown instance per message
// 2. Feed chunks as they arrive from WS events
// 3. Streamdown handles:
//    - Incomplete **bold** markers
//    - Unterminated ```code blocks
//    - Partial [links](
//    - Incomplete HTML tags
// 4. On stream end: final render pass to close any open syntax
//
// Implementation detail: Streamdown outputs DOM nodes. We wrap it in a
// React ref-based container that appends Streamdown's output DOM directly,
// bypassing React's virtual DOM for streaming performance.
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
  /** Route to open in the new window (e.g., "/workspace/abc-123"). */
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

```typescript
// main.tsx (runs in every window, including pop-outs)

async function bootstrap(): Promise<void> {
  // 1. Read daemon port + auth token from Tauri
  const daemonInfo = await invoke<DaemonInfo>('start_daemon');
  const authToken = await invoke<string>('read_auth_token');

  // 2. Initialize API client
  const client = new ApiClient({
    getBaseUrl: () => `http://localhost:${daemonInfo.port}`,
    getAuthToken: () => authToken,
  });

  // 3. Initialize WebSocket
  const ws = new WebSocketManager({
    getUrl: () => `ws://localhost:${daemonInfo.port}/ws`,
    getAuthToken: () => authToken,
  });

  // 4. Determine initial route
  //    Main window: "/" (workspace)
  //    Pop-out window: route from URL (e.g., "/workspace/abc-123")
  const route = window.location.pathname;

  // 5. Hydrate stores from REST
  if (route === '/' || route.startsWith('/workspace')) {
    const runs = await client.listRuns();
    useWorkspaceStore.getState().setRuns(runs);
  }

  // If this is a run detail pop-out, subscribe to that run's stream
  const runIdMatch = route.match(/\/workspace\/(.+)/);
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
  if (route === '/') {
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
| NFR-U8 Restore last-viewed run | §6.1 Workspace (lastRunConfig) |
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
