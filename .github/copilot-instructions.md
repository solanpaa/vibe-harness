# Copilot Instructions — Vibe Harness

## Commands

```bash
npm run dev          # Dev server on :3000
npm run build        # Production build (also runs TypeScript check)
npm run lint         # ESLint
npx drizzle-kit generate  # Generate migration after schema changes
```

No test suite exists yet. Use `npm run build` as the primary verification step.

## Architecture

Vibe Harness is a Next.js 16 App Router application that orchestrates AI coding agents (Copilot CLI, Claude Code, Gemini) running in Docker sandboxes. Users create **tasks** that run agents against git repositories, with optional **workflow** orchestration for multi-stage pipelines (plan → implement → review).

### Core domain model

- **Projects** — Git repositories with a `localPath` on the host
- **Tasks** — An agent execution against a project. Lifecycle: `pending → running → awaiting_review → completed/failed`. Each task runs in a Docker sandbox and optionally in a git worktree for isolation
- **Workflows** — Multi-stage templates (e.g. plan → implement → review). A workflow run creates tasks for each stage, advancing via `--continue` to preserve agent context
- **Reviews** — Auto-created when a task completes. Contains diff snapshot, AI summary, and inline comments. Approve advances the workflow; request changes reruns the same stage

### Task lifecycle and review gates

```
Task created → sandbox launched → agent runs → completes →
  auto-create review → status: awaiting_review →
    approve → (next workflow stage OR merge & complete)
    request changes → rerun same stage with --continue → awaiting_review again
```

Key: reviews are auto-created by `task-manager.ts` on successful completion. The user never manually creates reviews.

### Sandbox and worktree model

- Each task gets a sandbox named `vibe-{first8chars}` via `docker sandbox run`
- Worktrees are created under `<project>/.vibe-harness-worktrees/<shortId>/`
- Workflow stages share the same sandbox and worktree via `originTaskId` + `isContinuation: true` (passes `--continue` to the agent)
- The `activeSandboxes` Map is stored on `globalThis` to survive Next.js dev hot reloads

### Data flow

- **DB**: SQLite via Drizzle ORM (`better-sqlite3`), WAL mode, file at `./vibe-harness.db`
- **Schema**: `src/lib/db/schema.ts` — single source of truth. Run `npx drizzle-kit generate` after changes
- **Migrations**: `src/lib/db/migrations/` — applied automatically on first `getDb()` call
- **Services** (`src/lib/services/`): Server-only business logic. Never import from client components
- **API routes** (`src/app/api/`): Thin wrappers around services
- **Pages**: Client components (`"use client"`) that fetch from API routes

### Key service files

- `task-manager.ts` — Launches sandboxes, manages lifecycle, auto-creates reviews on completion
- `workflow-engine.ts` — Creates workflow runs, advances stages with `--continue`, builds combined prompts (task description + stage instructions)
- `review-rerun.ts` — Handles "request changes": bundles comments into prompt, reruns same stage
- `review-service.ts` — Creates reviews from git diffs, manages task chains via `originTaskId`
- `sandbox.ts` — Spawns `docker sandbox run` processes, manages active sandbox map
- `worktree.ts` — Git worktree creation, cleanup, commit-and-merge on approval

## Conventions

### Schema changes

1. Edit `src/lib/db/schema.ts`
2. Run `npx drizzle-kit generate`
3. Delete `./vibe-harness.db` if the migration is incompatible (dev-only, no prod data)

### Task chain tracking

Tasks spawned from reruns or workflow stages link back via `originTaskId`. Helper functions in `review-service.ts`:
- `getOriginTaskId(taskId)` — resolves the chain root
- `getTaskChainIds(originId)` — all tasks in a chain

Review round counting and worktree resolution use these to find the right origin.

### Combined workflow prompts

Workflow stages build prompts via `buildStagePrompt()` in `workflow-engine.ts`:
```
## Task
{user's task description}

## Current Stage: {stage name}
{stage prompt template}
```

### API patterns

- GET returns all rows (use `?fields=summary` on `/api/tasks` for lightweight listing without output)
- POST creates resources; for workflows use `action: "create_template"` or `action: "start_run"`
- PATCH on `/api/tasks/[id]` accepts `action: "start"` or `action: "stop"`
- Review submit: `POST /api/reviews/[id]/submit` with `action: "approve"` or `action: "request_changes"`

### Client-side status configs

Task/review status badge colors and icons are defined as `statusConfig` Record objects at the top of page components. Add new statuses there when extending the lifecycle.
