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
- Provides native multi-window experience for concurrent diff review, output monitoring, and workflow management
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

### 2.3 Conceptual Model

```
Workflow Run (user-facing — the only execution unit users interact with)
  ├── Docker sandbox (shared across all stages, lives for entire run)
  ├── Git worktree (shared across all stages, LLM-generated branch name)
  ├── ACP session (continuous by default; reset when stage has freshSession: true)
  │
  ├── Stage 1: "plan"
  │     ├── agent executes (prompt sent into conversation)
  │     ├── agent completes → diff snapshot → review gate
  │     ├── user requests changes → comments injected into conversation
  │     ├── agent executes again (round 2, same conversation)
  │     ├── agent completes → new diff snapshot → review gate (round 2)
  │     └── user approves → advance to next stage
  │
  ├── Stage 2: "implement"
  │     ├── stage prompt injected into conversation (--continue, agent has plan context)
  │     ├── agent executes → diff snapshot → review gate
  │     └── user approves → advance
  │
  └── Finalize: commit → rebase → merge → cleanup
```

**Key principles:**
1. **Users run workflow runs, never standalone tasks.** A "quick one-shot" is a workflow with a single auto-generated stage.
2. **Stages are execution phases, not separate entities.** There is no "Task" concept — stages ARE the execution. Messages accumulate in one continuous agent conversation.
3. **Reviews are snapshots.** Each time the agent completes within a stage, a review is created (diff + summary). Requesting changes feeds comments back into the same conversation. The agent continues from where it left off.
4. **One sandbox, one worktree per workflow run.** All stages share the same environment. Only split children get their own.
5. **`freshSession: true` resets the conversation** within the same sandbox/worktree. Previous plan context is injected as markdown into the fresh prompt.
6. **Split children are independent workflow runs** with their own sandbox, worktree (branched off parent's worktree), and fresh ACP session. They receive the proposal description as their prompt, NOT a continuation of the parent conversation.

### 2.4 Workflow Orchestration

| ID | Requirement | Priority |
|----|------------|----------|
| FR-W1 | User can create workflow templates defining a sequence of stages | Must |
| FR-W2 | Each stage has: name, type (`standard`/`split`), prompt template, review settings (`reviewRequired`/`autoAdvance` — mutually exclusive), session settings (`freshSession`: boolean) | Must |
| FR-W3 | User can start a workflow run against a project with a run description, credential set (optional), base branch (optional, default: current checked-out branch — must be an actual branch ref, not detached HEAD), and target branch (optional, default: base branch). A quick one-shot uses a default single-stage template | Must |
| FR-W4 | System executes stages sequentially. For each stage, the prompt is injected into the agent conversation (or a fresh conversation if `freshSession: true`). All stages share the same sandbox and worktree | Must |
| FR-W5 | Standard stages with `reviewRequired: true` pause for human review after agent completes | Must |
| FR-W6 | Standard stages with `autoAdvance: true` proceed to next stage without human review | Must |
| FR-W7 | By default, stages continue the ACP session (`--continue`). With `freshSession: true`, a new ACP session is started within the same sandbox/worktree. Context from prior stages is injected into the fresh prompt (see FR-W8) | Must |
| FR-W8 | System builds stage prompts: run description + stage instructions. For `freshSession` stages, the system also injects context from prior stages: (a) the agent's final assistant message from each completed stage, (b) plan.md content if captured from the sandbox, (c) the latest approved review summary. This replaces the lost conversation context | Must |
| FR-W9 | Workflow orchestration state is durable at suspension points (review gates, proposal gates). In-flight agent execution is NOT recoverable on daemon crash — the stage is marked failed with reason "daemon_restart" | Must |
| FR-W10 | User can cancel a running workflow. Sends ACP stop to agent; if no response within timeout (30s), force-kills sandbox. Worktree state preserved as-is (no final diff snapshot). Marks workflow cancelled. If workflow has active split children, cancellation cascades to all running children | Must |
| FR-W11 | System provides pre-built workflow templates: (a) "Quick Run" — single auto-advance stage, (b) "Plan & Implement" — plan → implement → commit, (c) "Full Review" — plan → implement → review → fix → commit | Must |
| FR-W12 | User can list, edit, and delete workflow templates (add/remove/reorder stages) | Must |
| FR-W13 | System auto-generates a title for workflow runs from the run description (LLM-based) | Should |
| FR-W14 | When agent execution fails mid-stage: workflow pauses in "stage_failed" state. User can: (a) **retry** — system sends a failure-aware message into the conversation: "The previous attempt failed with: {error}. Please retry: {stage prompt}" (not a duplicate prompt), (b) **skip** — advance to next stage (previous result = null), or (c) **cancel** — cancel the workflow. If the conversation itself is corrupted, user should cancel and start a new workflow run | Must |
| FR-W15 | System notifies user (via GUI) when a stage completes, fails, or requires review | Must |
| FR-W16 | User can view workflow execution history: stages completed, current stage, time per stage, full conversation log | Must |
| FR-W17 | Sandbox lifecycle: Docker sandbox created at workflow start, reused across all stages, stopped when workflow reaches a terminal state. On daemon restart, orphaned sandboxes are stopped | Must |
| FR-W18 | Worktree lifecycle: git worktree created at workflow start with LLM-generated branch name from run description (fallback: `vibe-harness/run-<shortId>`). Generated names are sanitized to valid git ref format and deduplicated with a numeric suffix if the branch already exists. Reused across all stages. Cleaned up after final merge on approval. On cancellation/failure, preserved for user inspection | Must |
| FR-W19 | The workflow run captures the **complete agent session log**: all tool calls (with arguments and results), reasoning/thought content, assistant messages, user interventions, system messages, and usage stats. The log is workflow-scoped and **never discarded** — a `freshSession` stage starts a new ACP session but prior messages are retained in the log with a session boundary marker. This ensures full audit trail even across session resets | Must |
| FR-W20 | User can observe real-time streaming agent output via WebSocket (< 100ms perceived latency) | Must |
| FR-W21 | User can send mid-execution messages (interventions) to the running agent via ACP stdin at any point during any stage | Must |
| FR-W22 | Credential set selection: workflow run's explicit credential set, or project's default, or none (in that priority order) | Must |

### 2.5 Split Execution (Parallel Workflows)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-S1 | A "split" stage runs an agent that generates proposals (sub-tasks). Each proposal describes an independent unit of work | Must |
| FR-S2 | Each proposal has: title, description, affected files, optional workflow template override. Dependencies between proposals are metadata-only (displayed to user during review for manual sequencing decisions, not enforced at runtime) | Must |
| FR-S3 | User can review, edit, add, and delete proposals before launching | Must |
| FR-S4 | User can select which proposals to launch as parallel child workflow runs | Must |
| FR-S5 | Each approved proposal launches as an independent **child workflow run** with its own Docker sandbox and git worktree. The child worktree is branched off the **parent workflow's worktree** (not HEAD), named with LLM-generated branch name from proposal title (sanitized, deduplicated). Fallback: `vibe-harness/split-<shortId>` | Must |
| FR-S6 | Child workflow runs can have their own multi-stage pipeline (from a specified template or a default single-stage template) | Must |
| FR-S7 | Parent workflow enters `waiting_for_children` state during split execution. System tracks parallel group: counts completed, failed, cancelled, and pending children. Cancelling the parent cascades cancellation to all running children | Must |
| FR-S8 | Consolidation begins when all children reach a terminal state (completed, failed, or cancelled). Only completed children are included in the merge | Must |
| FR-S9 | Consolidation merges child branches sequentially into a consolidation branch (created from parent worktree HEAD) using `--no-ff`. Merge order follows proposal sort order | Must |
| FR-S10 | On merge conflict during consolidation: system aborts the merge, marks the conflicting child, and presents the conflict to the user. User can: (a) resolve externally and retry consolidation, (b) exclude the conflicting child and re-consolidate, or (c) cancel consolidation | Must |
| FR-S11 | After successful consolidation review and approval: the parent worktree is fast-forwarded to the consolidation branch. Subsequent stages in the parent workflow continue on this updated worktree. The parent's ACP session does NOT continue from children — a `freshSession` is started for any post-split stage, with the consolidation summary as context | Must |
| FR-S12 | If any children failed: user is notified and can choose to consolidate completed children only, retry failed children, or cancel the parallel group | Must |
| FR-S13 | Child worktrees and sandboxes are cleaned up after successful consolidation merge. Failed/cancelled child worktrees are preserved until user explicitly deletes them | Must |

### 2.6 Human Review

| ID | Requirement | Priority |
|----|------------|----------|
| FR-R1 | Reviews are auto-created when the agent completes execution within a reviewable stage. A review is a diff snapshot at that point in time | Must |
| FR-R2 | Review shows: git diff (from merge-base to current worktree HEAD), AI-generated summary of changes, agent's plan.md (if captured from sandbox) | Must |
| FR-R3 | User can view the diff with a file tree navigator | Must |
| FR-R4 | User can add inline comments on specific lines of the diff | Should |
| FR-R5 | User can add general (non-file-specific) comments on a review | Must |
| FR-R6 | User can approve a review, which advances the workflow to the next stage | Must |
| FR-R7 | User can request changes: comments (general + inline) are bundled as markdown and injected into the agent conversation as a new user message. The agent continues in the same session — no new process created | Must |
| FR-R8 | After request-changes, the agent executes again within the same stage. On completion, a new review is created (next round). Round number increments | Must |
| FR-R9 | User can navigate between review rounds for the same stage | Should |
| FR-R10 | **Final approval git operations** (last stage of workflow): (a) commit all uncommitted changes in worktree, (b) rebase worktree branch onto target branch, (c) if rebase conflicts: abort rebase, present to user, user resolves externally and re-approves, (d) fast-forward merge into target branch, (e) clean up worktree, sandbox, and delete worktree branch | Must |
| FR-R11 | Consolidation reviews show combined diff from all successfully merged child branches | Must |

### 2.7 Credential Management

| ID | Requirement | Priority |
|----|------------|----------|
| FR-C1 | User can create named credential sets | Must |
| FR-C2 | Credential entries support types: environment variable, file mount, Docker login | Must |
| FR-C3 | Credential values are encrypted at rest using AES-256. Encryption key stored in macOS Keychain or Linux libsecret. Fallback: key stored in `~/.vibe-harness/encryption.key` with 0600 permissions | Must |
| FR-C4 | Credentials are injected into Docker sandboxes at workflow run start: env vars via `-e`, file mounts via stdin pipe to `tee`, Docker logins via `docker login --password-stdin` | Must |
| FR-C5 | System maintains an audit log of credential access (create, delete, access-by-workflow-run) | Should |
| FR-C6 | Credential sets can be scoped to a project or global. Project-scoped sets are only visible when that project is selected | Should |
| FR-C7 | Credential values are never returned to the GUI in plaintext. API returns masked values (`***`) | Must |
| FR-C8 | Credentials are not logged or included in streaming output. Daemon logs must not contain decrypted credential values | Must |

### 2.8 Statistics & Dashboard

| ID | Requirement | Priority |
|----|------------|----------|
| FR-D1 | User can see workspace summary: running workflows, pending reviews, recent activity | Must |
| FR-D2 | User can see recent workflow run history | Must |
| FR-D3 | User can filter/search workflow runs by status, project, or text | Should |

---

## 3. Non-Functional Requirements

### 3.1 Installation & Distribution

| ID | Requirement | Priority |
|----|------------|----------|
| NFR-I1 | GUI users: single app download (`.dmg` for macOS, `.AppImage` for Linux). No Node.js or other runtime dependencies beyond Docker and Git | Must |
| NFR-I2 | Developer users: installable from source with minimal setup (< 3 commands) | Must |
| NFR-I3 | Daemon starts automatically when GUI launches (Tauri sidecar) | Must |
| NFR-I4 | System checks for prerequisites on first launch: Docker installed and running, `docker sandbox` available, Git installed, GitHub auth configured. Displays actionable guidance for any missing prerequisite | Must |
| NFR-I5 | Docker sandbox image is auto-built on first workflow run if not present (or user is prompted to build it) | Should |

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
| NFR-R6 | Workflow run start operations are idempotent (re-starting a running workflow returns current status) | Should |
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
| NFR-U2 | Keyboard shortcuts for common actions (new run, navigate list, command palette) | Should |
| NFR-U3 | Command palette (⌘K) for quick navigation across tasks, projects, workflows | Should |
| NFR-U4 | Streaming markdown output renders correctly during streaming — handles incomplete syntax (unclosed bold, partial code blocks, unterminated links) via Streamdown | Must |
| NFR-U5 | Diff viewer supports unified view (side-by-side is deferred) | Must |
| NFR-U6 | GUI shows clear status when daemon is unreachable (crashed/not started) with auto-reconnect. Streaming output replays missed events on WebSocket reconnection using last-seen event ID | Must |
| NFR-U7 | GUI discovers daemon via port file (`~/.vibe-harness/daemon.port`). On Tauri launch, if no daemon found, starts sidecar automatically | Must |
| NFR-U8 | GUI restores last-viewed workflow run on restart | Should |

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
- Workflow orchestration with stages, review gates, and continuous agent conversation
- Split execution (proposals → parallel child workflow runs → consolidation merge)
- Tauri GUI with workspace, diff viewer, workflow editor
- Background daemon with REST API + WebSocket streaming
- Durable workflows (survive restart at hook points)
- Quick one-shot runs (single-stage workflow — no "standalone task" concept)

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
3. Docker sandbox images must be pre-built before first workflow run execution
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

### UC-1: Quick One-Shot Run
**Actor:** Developer
**Precondition:** Project registered, Docker running
**Flow:**
1. User opens GUI, clicks "New Run"
2. Selects project, enters prompt (e.g., "Fix the login bug"), optionally selects credential set and target branch
3. Clicks "Run" → system uses "Quick Run" template (single auto-advance stage)
4. Sandbox + worktree created (LLM-generated branch name), agent starts executing
5. User observes streaming output in real-time
6. Agent completes → diff generated, review created
7. User reviews diff, adds comments, approves
8. System commits, rebases, merges to target branch, cleans up sandbox + worktree
**Error flows:**
- 4a. Sandbox provisioning fails → workflow marked failed, user sees error
- 6a. Agent fails → stage_failed state, user can retry or cancel
- 8a. Rebase conflict → user resolves externally, re-approves

### UC-2: Multi-Stage Workflow
**Actor:** Developer
**Flow:**
1. User starts workflow run: selects "Full Review" template, project, enters run description
2. Stage 1 ("plan"): prompt injected into conversation → agent plans → review gate
3. User reviews plan, approves
4. Stage 2 ("implement"): stage prompt injected into same conversation (`--continue`) → agent implements → review gate
5. User reviews code diff, requests changes with comments
6. Comments injected into conversation as user message → agent continues in same session → new review (round 2)
7. User approves round 2
8. Stage 3 ("commit"): auto-advance, agent finalizes
9. System performs final git operations: commit, rebase, merge, cleanup
**Error flows:**
- 2a. Agent fails → workflow pauses (stage_failed). User retries, skips, or cancels
- 9a. Rebase conflict → user resolves externally, re-triggers finalization

### UC-3: Split Execution
**Actor:** Developer
**Flow:**
1. Workflow reaches "split" stage → agent generates proposals
2. User reviews proposals: edits descriptions, removes one, approves 3 of 4
3. System creates ParallelGroup, launches 3 child workflow runs (each with own sandbox + worktree branched off parent's worktree)
4. User monitors all 3 in the workflow feed (each runs its own stages independently)
5. 2 complete successfully, 1 fails
6. User chooses to consolidate the 2 successful children
7. System merges 2 child branches into consolidation branch
8. User reviews consolidated changes → approves
9. System merges to target branch, cleans up child sandboxes + worktrees
**Error flows:**
- 7a. Merge conflict → system aborts, shows conflicting child. User excludes or resolves externally

### UC-4: Mid-Execution Intervention
**Actor:** Developer
**Flow:**
1. Workflow is running, user observes agent going in wrong direction
2. User types message: "Stop, focus on the auth module first"
3. System sends message via ACP stdin to the running agent
4. Agent receives message, adjusts course (visible in streaming output)
5. Execution continues with corrected approach

### UC-5: Daemon Restart Recovery
**Actor:** System (automatic)
**Flow:**
1. Daemon starts → checks PID file, detects fresh start
2. Enumerates Docker sandboxes via `docker sandbox ls --filter name=vibe-*`
3. Orphaned sandboxes (no matching running workflow) → stopped
4. Workflows with active stages but no live sandbox → stage marked failed (reason: "daemon_restart")
5. Workflow hook state intact (`.workflow-data/`) → user can still approve pending reviews or retry failed stages
6. User opens GUI → sees failed stages with clear reason, can retry or cancel

### UC-6: First Launch
**Actor:** New user
**Flow:**
1. User downloads `.dmg`, installs, launches app
2. Tauri starts daemon sidecar
3. Daemon runs prerequisite checks: Docker, `docker sandbox`, Git, GitHub auth
4. Missing prerequisite → guided setup page
5. All met → empty workspace with "Add Project" prompt
6. User adds first project, starts first workflow run

---

## 6. Traceability

This SRD feeds into:
- **SAD.md** — Architecture decisions trace back to requirements
- **CDD.md** — Component designs implement specific functional requirements
- **IMPL.md** — Implementation phases deliver groups of requirements
