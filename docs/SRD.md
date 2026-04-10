# Vibe Harness v2 — Solution Requirements Description (SRD)

## 1. Purpose & Scope

### 1.1 Problem Statement

Vibe Harness is a tool for orchestrating AI coding agents (GitHub Copilot CLI, Claude Code, Gemini CLI) running in Docker sandboxes against git repositories. It manages multi-stage workflows with human review gates, git worktree isolation, and parallel execution.

Vibe Harness v1 exists as a working Next.js browser application but has fundamental UX and distribution problems:
- **Installation friction:** Requires `npm install`, build step, and running a Node.js server. Error-prone for non-Node.js developers.
- **Browser UX limitations:** Single browser tab, no native multi-window support, no OS-level window management (tiling, monitors). Reviewing diffs while observing agent output requires tab-switching.
- **Architectural degradation:** Codebase evolved organically. State management is ad-hoc (xstate partially adopted). Services have circular dependencies. `globalThis` hacks for hot-reload survival.
- **No durability:** Workflows don't survive daemon restarts. In-memory session maps are lost.

### 1.2 Solution Vision

A desktop-native AI agent orchestrator that:
- Installs with a single app download (GUI) or a single command (CLI)
- Provides native multi-window experience for concurrent diff review, output monitoring, and task management
- Runs a background daemon for durable workflow orchestration
- Uses proper durable workflows that survive restarts

### 1.3 Target Platforms
- macOS (primary)
- Linux (secondary)
- Windows: not a target for now

### 1.4 Target Users
- Software developers using AI coding agents
- Teams managing multiple AI-assisted coding tasks
- Individual developers wanting structured agent workflows

---

## 2. Functional Requirements

### 2.1 Project Management

| ID | Requirement | Priority |
|----|------------|----------|
| FR-P1 | User can register a local git repository as a project | Must |
| FR-P2 | User can list all registered projects | Must |
| FR-P3 | User can remove a registered project | Must |
| FR-P4 | User can update project metadata (name, description) | Should |
| FR-P5 | User can view git branches for a project | Must |
| FR-P6 | User can assign a default credential set to a project | Should |
| FR-P7 | System validates that the path is a valid git repository on registration | Must |

### 2.2 Agent Definitions

| ID | Requirement | Priority |
|----|------------|----------|
| FR-A1 | User can define an agent with: name, type, command template, Docker image. MVP supports `copilot_cli` only; other types (claude_cli, gemini_cli) are deferred | Must |
| FR-A2 | User can list, edit, and delete agent definitions | Must |
| FR-A3 | System provides a default agent definition for Copilot CLI | Must |
| FR-A4 | Agent definitions include a capability declaration: supports_continue (boolean), supports_intervention (boolean), supports_streaming (boolean), output_format (jsonl/acp/text) | Must |
| FR-A5 | System validates that required agent capabilities are present before starting a workflow (e.g., `supports_continue` required for multi-stage workflows) | Should |

### 2.3 Task Execution

| ID | Requirement | Priority |
|----|------------|----------|
| FR-T1 | User can create a task by specifying: project, agent, prompt, credential set (optional, inherits project default), and optional settings (model, worktree toggle, base branch, target branch) | Must |
| FR-T2 | User can start a task, which provisions a Docker sandbox and launches the agent | Must |
| FR-T3 | Each task runs in an isolated Docker sandbox (via `docker sandbox run`) | Must |
| FR-T4 | Each task optionally runs in a git worktree for branch isolation. Worktree branch named `vibe-harness/task-<shortId>` created from the specified base branch (default: HEAD) | Must |
| FR-T5 | User can observe real-time streaming output from the agent while it runs (via WebSocket, rendered with < 100ms perceived latency) | Must |
| FR-T6 | User can send mid-execution messages (interventions) to a running agent via ACP stdin | Must |
| FR-T7 | ~~User can pause a running task~~ | **DROPPED** — Docker sandbox pause/unpause is unreliable with AI agents. Use cancel (FR-T8) instead |
| FR-T8 | User can cancel a running task (kills sandbox process, marks task failed with reason "cancelled") | Must |
| FR-T9 | User can view task history: prompt, output, status, exit code, usage stats (tokens, duration, cost, model) | Must |
| FR-T10 | System generates a diff of all changes when a task completes. Diff base is the merge-base between the task branch and the target branch | Must |
| FR-T11 | Standalone tasks (no workflow) auto-create a review on completion | Must |
| FR-T12 | User can view conversation history (user/assistant/system messages) for a task | Must |
| FR-T13 | On task completion (success or failure): worktree is preserved until review approval; on approval, worktree is cleaned up after merge; on cancellation, worktree is cleaned up immediately | Must |
| FR-T14 | On task completion (success or failure): Docker sandbox container is stopped. On daemon restart, orphaned containers discovered via `docker sandbox ls` are stopped and associated tasks marked failed with reason "daemon_restart" | Must |
| FR-T15 | Credential set selection: task uses explicitly specified credential set, or project's default credential set, or no credentials (in that priority order) | Must |

### 2.4 Workflow Orchestration

| ID | Requirement | Priority |
|----|------------|----------|
| FR-W1 | User can create workflow templates defining a sequence of stages | Must |
| FR-W2 | Each stage has: name, type (`standard`/`split`), prompt template, review settings (`reviewRequired`/`autoAdvance` — mutually exclusive), session settings (`freshSession`: boolean) | Must |
| FR-W3 | User can start a workflow run against a project with a task description, credential set (optional), base branch (optional, default: HEAD), and target branch (optional, default: base branch) | Must |
| FR-W4 | System executes stages sequentially, creating a task per stage | Must |
| FR-W5 | Standard stages with `reviewRequired: true` pause for human review before advancing | Must |
| FR-W6 | Standard stages with `autoAdvance: true` proceed to next stage without human review | Must |
| FR-W7 | Consecutive stages share Copilot CLI ACP session context (agent remembers previous stages via `--continue`) unless `freshSession: true`. Session continuation is agent-specific; future agent types may not support it | Must |
| FR-W8 | System builds combined prompts: task description + stage instructions + (for `freshSession` stages) previous plan context injected as markdown | Must |
| FR-W9 | Workflow orchestration state is durable at suspension points (review gates, proposal gates, sleep). In-flight tasks (agent actively executing) are NOT recoverable on daemon crash — they are marked failed with reason "daemon_restart" | Must |
| FR-W10 | User can cancel a running workflow (cancels current task, marks workflow cancelled) | Must |
| FR-W11 | System provides pre-built workflow templates (e.g., plan → implement → review → commit) | Should |
| FR-W12 | User can list, edit, and delete workflow templates (add/remove/reorder stages) | Must |
| FR-W13 | System auto-generates a title for workflow runs from the task description | Should |
| FR-W14 | When a task fails mid-workflow: workflow pauses in a "stage_failed" state. User can retry the failed stage, skip it (advance to next), or cancel the workflow | Must |
| FR-W15 | System notifies user (via GUI) when a workflow stage completes, fails, or requires review | Must |
| FR-W16 | User can view workflow execution history: stages completed, current stage, time per stage | Must |

### 2.5 Split Execution (Parallel Workflows)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-S1 | A "split" stage runs an agent that generates proposals (sub-tasks) | Must |
| FR-S2 | Each proposal has: title, description, affected files. Dependencies between proposals are metadata-only (not enforced at runtime) | Must |
| FR-S3 | User can review, edit, add, and delete proposals before launching | Must |
| FR-S4 | User can select which proposals to launch as parallel child workflows | Must |
| FR-S5 | Each approved proposal launches as an independent child workflow run in its own worktree, created on launch and named `vibe-harness/split-<shortId>` | Must |
| FR-S6 | System tracks parallel group: counts completed, failed, cancelled, and pending children | Must |
| FR-S7 | Consolidation begins when all children reach a terminal state (completed, failed, or cancelled). Only completed children are included in the merge | Must |
| FR-S8 | Consolidation merges child branches sequentially into a consolidation branch using `--no-ff`. Merge order follows proposal sort order | Must |
| FR-S9 | On merge conflict during consolidation: system aborts the merge, marks the conflicting child, and presents the conflict to the user. User can: (a) resolve externally and retry consolidation, (b) exclude the conflicting child and re-consolidate, or (c) cancel consolidation | Must |
| FR-S10 | User reviews the consolidated result (combined diff from all merged children) before final merge to target branch | Must |
| FR-S11 | If any children failed: user is notified and can choose to consolidate completed children only, retry failed children, or cancel the parallel group | Must |
| FR-S12 | Child worktrees are cleaned up after successful consolidation merge. Failed/cancelled child worktrees are preserved until user explicitly deletes them or the parallel group is deleted | Must |

### 2.6 Human Review

| ID | Requirement | Priority |
|----|------------|----------|
| FR-R1 | Reviews are auto-created when a task completes a reviewable stage | Must |
| FR-R2 | Review shows: git diff (from merge-base to HEAD of task branch), AI-generated summary of changes, agent's plan.md (if captured from sandbox) | Must |
| FR-R3 | User can view the diff with a file tree navigator | Must |
| FR-R4 | User can add inline comments on specific lines of the diff | Should |
| FR-R5 | User can add general (non-file-specific) comments on a review | Must |
| FR-R6 | User can approve a review, which advances the workflow to the next stage | Must |
| FR-R7 | User can request changes, which triggers a rerun of the same stage with bundled comment feedback (general + file-specific comments formatted as markdown) | Must |
| FR-R8 | Reruns use Copilot CLI `--continue` flag for ACP session continuity (agent remembers previous attempt + receives review comments as new prompt) | Must |
| FR-R9 | Review tracks round number (round 1, 2, 3... for reruns). New review created per rerun | Must |
| FR-R10 | User can navigate between review rounds for the same stage | Should |
| FR-R11 | **Final approval git operations** (last stage or standalone task): (a) commit all uncommitted changes in worktree with auto-generated message, (b) rebase worktree branch onto target branch, (c) if rebase conflicts: abort rebase, present conflict to user, user must resolve externally and re-approve, (d) fast-forward merge into target branch, (e) clean up worktree and delete task branch | Must |
| FR-R12 | Consolidation reviews show combined diff from all successfully merged child branches | Must |
| FR-R13 | Standalone task approval: same git operations as FR-R11 (commit, rebase, merge to target branch). Target branch defaults to the branch that was checked out when the task was created | Must |

### 2.7 Credential Management

| ID | Requirement | Priority |
|----|------------|----------|
| FR-C1 | User can create named credential sets | Must |
| FR-C2 | Credential entries support types: environment variable, file mount, Docker login | Must |
| FR-C3 | Credential values are encrypted at rest using AES-256. Encryption key stored in macOS Keychain or Linux libsecret. Fallback: key stored in `~/.vibe-harness/encryption.key` with 0600 permissions | Must |
| FR-C4 | Credentials are injected into Docker sandboxes at task start: env vars via `-e`, file mounts via stdin pipe to `tee`, Docker logins via `docker login --password-stdin` | Must |
| FR-C5 | System maintains an audit log of credential access (create, delete, access-by-task) | Should |
| FR-C6 | Credential sets can be scoped to a project or global. Project-scoped sets are only visible when that project is selected | Should |
| FR-C7 | Credential values are never returned to the GUI in plaintext. API returns masked values (`***`) | Must |
| FR-C8 | Credentials are not logged or included in streaming output. Daemon logs must not contain decrypted credential values | Must |

### 2.8 Statistics & Dashboard

| ID | Requirement | Priority |
|----|------------|----------|
| FR-D1 | User can see workspace summary: active tasks, pending reviews, active workflows | Must |
| FR-D2 | User can see recent task history | Must |
| FR-D3 | User can filter/search tasks by status, project, or text | Should |

---

## 3. Non-Functional Requirements

### 3.1 Installation & Distribution

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-I1 | GUI users: single app download (`.dmg` for macOS, `.AppImage` for Linux). No Node.js or other runtime dependencies beyond Docker and Git | Must |
| NFR-I2 | Developer users: installable from source with minimal setup (< 3 commands) | Must |
| NFR-I3 | Daemon starts automatically when GUI launches (Tauri sidecar) | Must |
| NFR-I4 | System checks for prerequisites on first launch: Docker installed and running, `docker sandbox` available, Git installed, GitHub auth configured. Displays actionable guidance for any missing prerequisite | Must |
| NFR-I5 | Docker sandbox image is auto-built on first task if not present (or user is prompted to build it) | Should |

### 3.2 Performance

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-P1 | Agent streaming output renders with < 100ms perceived latency from daemon WebSocket send to GUI render callback, on typical developer hardware (16GB RAM, 4+ cores) | Should |
| NFR-P2 | Daemon handles at least 10 concurrent tasks with active streaming on typical developer hardware | Should |
| NFR-P3 | GUI remains responsive (< 16ms frame time) while multiple tasks stream output. Large outputs must use virtualization/chunking | Must |
| NFR-P4 | Workflow state operations (start, advance, suspend, resume) complete in < 500ms | Should |

### 3.3 Reliability & Durability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-R1 | Workflow orchestration state at suspension points (review gates, proposal gates) survives daemon restarts. Completed step results are replayed, not re-executed | Must |
| NFR-R2 | Tasks actively executing when daemon crashes are NOT recoverable. On restart, these tasks are marked failed with reason "daemon_restart" | Must |
| NFR-R3 | On daemon restart: enumerate running Docker sandboxes via `docker sandbox ls`, reconcile with DB state. Orphaned sandboxes are stopped. Tasks in "running"/"provisioning" state with no live sandbox are marked failed | Must |
| NFR-R4 | Database operations use WAL mode for concurrent read/write safety | Must |
| NFR-R5 | Approve/reject operations are idempotent (re-approving an approved review is a no-op) | Must |
| NFR-R6 | Task start operations are idempotent (re-starting a running task returns current status) | Should |
| NFR-R7 | Data retention: workflow state files (`.workflow-data/`), agent output, and diff snapshots are retained for 30 days by default. Configurable. Orphaned worktrees older than 7 days are flagged for cleanup | Should |

### 3.4 Security

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-S1 | Daemon HTTP endpoint protected by per-install auth token (Bearer header) | Must |
| NFR-S2 | Auth token auto-generated on first daemon start, stored in `~/.vibe-harness/auth.token` with 0600 permissions | Must |
| NFR-S3 | Credentials encrypted at rest using AES-256. Key stored in macOS Keychain / Linux libsecret, with file-based fallback (0600 permissions) | Must |
| NFR-S4 | Daemon binds to localhost only — no network exposure | Must |
| NFR-S5 | Git ref arguments validated to prevent command injection (block backticks, $, ;, pipes, ..) | Must |
| NFR-S6 | Docker sandboxes: no host filesystem mounts beyond the project worktree directory. Network egress controlled by `docker sandbox network proxy` | Must |
| NFR-S7 | Credential values never appear in daemon logs, streaming output, or GUI-facing API responses (always masked) | Must |

### 3.5 User Experience

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-U1 | GUI supports native multi-window (open multiple tasks/reviews in separate OS windows) | Must |
| NFR-U2 | Keyboard shortcuts for common actions (new task, navigate list, command palette) | Should |
| NFR-U3 | Command palette (⌘K) for quick navigation across tasks, projects, workflows | Should |
| NFR-U4 | Streaming markdown output renders correctly during streaming — handles incomplete syntax (unclosed bold, partial code blocks, unterminated links) via Streamdown | Must |
| NFR-U5 | Diff viewer supports unified view (side-by-side is deferred) | Must |
| NFR-U6 | GUI shows clear status when daemon is unreachable (crashed/not started) with auto-reconnect. Streaming output replays missed events on WebSocket reconnection using last-seen event ID | Must |
| NFR-U7 | GUI discovers daemon via port file (`~/.vibe-harness/daemon.port`). On Tauri launch, if no daemon found, starts sidecar automatically | Must |
| NFR-U8 | GUI restores last-viewed task/workflow on restart | Should |

### 3.6 Observability

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-O1 | Daemon produces structured JSON logs | Must |
| NFR-O2 | Workflow runs expose step-level execution history for debugging | Should |
| NFR-O3 | Health endpoint (`/health`) for daemon status checks | Must |

---

## 4. Scope Boundaries

### 4.1 In Scope (MVP)

- Projects, agent definitions, credential management
- Standalone task execution with streaming + review
- Sequential workflow orchestration with review gates
- Split execution (proposals → parallel child workflows → consolidation merge)
- Tauri GUI with workspace, diff viewer, workflow editor
- Background daemon with REST API + WebSocket streaming
- Durable workflows (survive restart at hook points)

### 4.2 Explicitly Out of Scope

| Feature | Reason |
|---------|--------|
| Comparison groups (multi-model runs) | Dropped — not needed |
| Windows platform support | Deferred — macOS + Linux only |
| CLI tool | Deferred to post-MVP phase (GUI + daemon only) |
| Cloud/remote daemon | Local-only tool |
| Multi-user / collaboration | Single-user local tool |
| Custom MCP server configuration in GUI | Daemon-side only |
| Claude Code / Gemini CLI agent support | Deferred — Copilot CLI only for MVP |
| v1 data migration | Users start fresh with v2. v1 codebase kept in `v1/` for reference |
| Side-by-side diff view | Unified diff only for MVP; side-by-side deferred |

### 4.3 Assumptions

1. Docker Desktop or equivalent is installed on the user's machine
2. `docker sandbox` command is available (Docker Desktop with sandbox support)
3. Git is installed and accessible from the daemon process
4. The user has GitHub credentials configured (`gh auth` or `GITHUB_TOKEN`)
5. Projects are local git repositories (not remote-only)

### 4.4 Constraints

1. `use workflow` SDK is in beta (4.2.0-beta.67) — API may change
2. Nitro build system required for workflow directive compilation
3. Docker sandbox images must be pre-built before first task execution
4. SQLite single-writer constraint (WAL mode mitigates but doesn't eliminate)
5. MVP supports Copilot CLI only — agent abstraction designed for extensibility but only one implementation

### 4.5 Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `use workflow` SDK breaks in future beta | Workflow engine rewrite | Pin version, monitor changelog, spike proved core features work |
| `docker sandbox` API changes or requires paid tier | Execution model breaks | Abstract sandbox interface; `docker sandbox` is the only impl for now |
| Nitro build system instability (alpha) | Build failures | Custom adapter fallback proven in spike |
| Large repos cause slow worktree/diff operations | UX degradation | Diff size limits, async operations with progress indicators |
| SQLite contention under high concurrency | Write failures | WAL mode, busy timeout, write serialization in daemon |

---

## 5. Use Cases

### UC-1: Run a Standalone Task
**Actor:** Developer
**Precondition:** Project registered, agent definition exists, Docker running
**Flow:**
1. User opens GUI, clicks "New Task"
2. Selects project, agent, enters prompt, optionally selects credential set and target branch
3. Clicks "Create" → task appears in feed (status: pending)
4. Clicks "Start" → sandbox provisions (worktree created, Docker sandbox launched)
5. User observes streaming markdown output in real-time via WebSocket
6. Agent completes → system generates diff (merge-base to HEAD of task branch), auto-creates review
7. User reviews diff in file tree + unified diff viewer, adds comments
8. User approves → system commits, rebases onto target branch, fast-forward merges, cleans up worktree
**Error flows:**
- 4a. Sandbox provisioning fails → task marked failed, user sees error message
- 6a. Agent fails (non-zero exit) → task marked failed, review still created with partial diff
- 8a. Rebase conflict → system aborts rebase, presents conflict to user, user resolves externally and re-approves

### UC-2: Run a Multi-Stage Workflow
**Actor:** Developer
**Precondition:** Workflow template exists, project registered
**Flow:**
1. User starts workflow run: selects template, project, enters task description
2. Stage 1 ("plan"): system creates task, launches agent with combined prompt → agent plans → review gate
3. User reviews plan in markdown, approves
4. Stage 2 ("implement"): system creates task with `--continue` (same ACP session), agent implements → review gate
5. User reviews code diff, requests changes with inline comments
6. System bundles comments, creates rerun task (round 2) with `--continue` and comment feedback
7. User reviews round 2 diff, approves
8. Stage 3 ("commit"): system creates task with `autoAdvance`, agent finalizes → auto-advance (no review)
9. System performs final git operations: commit, rebase, merge to target branch, cleanup
**Error flows:**
- 2a. Task fails → workflow enters "stage_failed" state. User can retry, skip, or cancel
- 9a. Rebase conflict → system presents conflict, user resolves and re-triggers finalization

### UC-3: Split Execution
**Actor:** Developer
**Flow:**
1. Workflow reaches "split" stage → agent generates proposals (sub-tasks)
2. User reviews proposals: edits descriptions, removes one, approves 3 of 4
3. System creates ParallelGroup, launches 3 child workflows (each in own worktree)
4. User monitors all 3 in the task feed (each runs independently)
5. 2 complete successfully, 1 fails
6. User is notified. Chooses to consolidate the 2 successful children
7. System merges 2 child branches sequentially into consolidation branch
8. User reviews consolidated changes (combined diff) → approves
9. System merges to target branch, cleans up worktrees
**Error flows:**
- 7a. Merge conflict between child branches → system aborts, shows conflicting child. User can exclude it and retry, or resolve externally

### UC-4: Mid-Execution Intervention
**Actor:** Developer
**Flow:**
1. Task is running, user observes agent going in wrong direction in streaming output
2. User types message in intervention input: "Stop, focus on the auth module first"
3. System sends message via ACP stdin to running agent
4. Agent receives message, adjusts course (visible in streaming output)
5. Task continues with corrected approach

### UC-5: Daemon Restart Recovery
**Actor:** System (automatic)
**Trigger:** Daemon process starts after a crash or manual restart
**Flow:**
1. Daemon starts → reads PID file, detects it's a fresh start (not a running daemon)
2. Enumerates Docker sandboxes via `docker sandbox ls --filter name=vibe-*`
3. For each sandbox found: checks DB for matching task in "running"/"provisioning" state
4. Orphaned sandboxes (no matching task) → stopped and removed
5. Tasks in "running"/"provisioning" with no live sandbox → marked failed (reason: "daemon_restart")
6. Checks workflow state files (`.workflow-data/`) → hook-suspended workflows are intact
7. User opens GUI → sees failed tasks with clear "daemon_restart" reason. Workflow-level state is preserved — user can restart failed stages or approve pending reviews

### UC-6: First Launch / Prerequisites Check
**Actor:** New user
**Flow:**
1. User downloads `.dmg`, installs, launches app
2. Tauri starts daemon sidecar
3. Daemon runs prerequisite checks: Docker, `docker sandbox`, Git, GitHub auth
4. Missing prerequisite → GUI shows guided setup page with instructions per item
5. All prerequisites met → GUI shows empty workspace with "Add Project" prompt
6. User adds first project, creates first task

---

## 6. Traceability

This SRD feeds into:
- **SAD.md** — Architecture decisions trace back to requirements
- **CDD.md** — Component designs implement specific functional requirements
- **IMPL.md** — Implementation phases deliver groups of requirements
