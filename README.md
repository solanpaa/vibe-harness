# Vibe Harness

AI coding agent orchestrator — run GitHub Copilot CLI in Docker sandboxes with multi-stage workflow pipelines, human-in-the-loop code reviews, and parallel execution.

## What It Does

Vibe Harness wraps GitHub Copilot CLI in a web-based orchestration layer that adds:

- **Multi-stage workflows** — Plan → Implement → Review → Fix → Commit, with automatic stage progression
- **Human review gates** — Pause between stages to review diffs, add inline comments, approve or request changes
- **Git worktree isolation** — Each task runs on its own branch; changes merge to main only after approval
- **Mid-task intervention** — Send follow-up messages to the agent while it's working
- **Parallel execution** — Split work into independent sub-tasks that run concurrently
- **Credential injection** — Securely pass environment variables and file mounts into sandboxes

## Quick Start

```bash
npx github:solanpaa/vibe-harness
```

This checks prerequisites, installs dependencies, builds the app on first run, and opens the UI at [http://localhost:3000](http://localhost:3000).

### Options

```bash
npx github:solanpaa/vibe-harness --port 4000          # Custom port
npx github:solanpaa/vibe-harness --no-open             # Don't open browser
npx github:solanpaa/vibe-harness --data-dir ~/my-data  # Custom data directory
```

### Global Install

```bash
npm install -g github:solanpaa/vibe-harness
vibe-harness
```

### Pin a Version

```bash
npx github:solanpaa/vibe-harness#v0.2.0   # Tagged release
npx github:solanpaa/vibe-harness#main      # Latest main
```

## Prerequisites

All checked automatically on startup:

- **Node.js >= 24**
- **Docker Desktop** — running
- **git**
- **GitHub CLI** (`gh`) — installed and authenticated
- **GitHub Copilot CLI** (`copilot`) — installed via `gh extension install github/gh-copilot`

## How It Works

### Projects

Point Vibe Harness at a local git repository. The agent works in an isolated git worktree so your working directory stays clean.

### Tasks

A task is a single agent execution. Create a task with a prompt, and the agent runs inside a Docker sandbox with your project mounted. You can send follow-up messages while it's running.

### Workflows

Workflows chain multiple tasks into a pipeline. The default workflow has five stages:

1. **Plan** — Agent analyzes the codebase and creates an implementation plan (no code changes)
2. **Implement** — Agent implements the plan (auto-advances to review)
3. **Review** — Agent reviews its own implementation against the plan (auto-advances to fix)
4. **Fix** — Agent addresses any issues found during review
5. **Commit** — Agent prepares a clean commit with a conventional commit message

Stages with `reviewRequired` pause for human approval. Approve to advance, or request changes to have the agent try again with your feedback.

### Reviews

When a task completes, you can create a review to inspect the diff, add inline comments, and approve or request changes. Approving a standalone task merges the worktree branch to main. Approving a workflow stage advances to the next stage.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘N` | New task |
| `↑` / `k` | Navigate up |
| `↓` / `j` | Navigate down |
| `Esc` | Clear selection |

## Data Directory

Database is stored at `~/.vibe-harness/vibe-harness.db` (SQLite). Override with `--data-dir` or `DATABASE_URL=file:/path/to/db.sqlite`.

## Development

```bash
npm install
npm run dev          # Dev server on :3000
npm run build        # Production build (includes type checking)
npm run lint         # ESLint
npm run test         # Vitest
```

The dev server uses `./vibe-harness.db` in the project root. Delete it to reset.

## Custom Sandbox Image

The default Docker sandbox extends the official Copilot CLI image with additional tools:

- **Node.js 25** + npm, pnpm, TypeScript, tsx
- **Python 3.14** (via uv)
- **uv / uvx** (Astral Python package manager)
- **Terraform** (latest)
- **MCP bridge** for tool calls back to the host

### Building

```bash
./docker/build.sh
# or:
docker build -t vibe-harness/copilot:latest -f docker/Dockerfile.copilot docker/
```

The image is built automatically on first run if missing.

### Customizing

Edit `docker/Dockerfile.copilot` and rebuild. The agent definition in the database points to the image tag — update it via the Settings page or the API if you change the tag.
