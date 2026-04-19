# AGENTS.md — Vibe Harness

## What This Is

Vibe Harness is a desktop-native orchestrator for AI coding agents (GitHub Copilot CLI, Claude Code, Gemini CLI). It runs agents in isolated `sbx` sandboxes against local git repositories, managing multi-stage workflows with human review gates, git worktree isolation, and parallel execution.

Users define a task ("add OAuth to the API"), the system launches an AI agent in a sandbox, streams its output in real-time, and presents the resulting code changes for human review. Workflows chain multiple stages (plan → implement → review → commit) with session continuity, so the agent remembers context across stages.

## Architecture

| Component | Technology |
|-----------|-----------|
| **Daemon** | Node.js + Hono + Nitro + `use workflow` |
| **GUI** | Tauri 2.0 + React + Vite + Streamdown |
| **CLI** | Post-MVP |
| **Shared types** | TypeScript workspace package |

Key architectural properties:
- **Daemon + GUI separation** — daemon owns all state and logic; GUI is a thin presentation client
- **Durable workflows** — Vercel's `use workflow` SDK provides event-sourced, resumable orchestration that survives daemon restarts at review gates
- **Native desktop app** — Tauri provides native multi-window support for concurrent diff review and output monitoring
- **Single-binary distribution** — no `npm install` for end users

> Historical note: a v1 Next.js browser application previously lived in `v1/`. It has been removed; the current root is the v2 rewrite. Use git history if you need to reference v1.

### Design Documents (in `docs/`)

| Document | Description |
|----------|-------------|
| `SRD.md` | Solution Requirements Description — 80+ functional and non-functional requirements |
| `SAD.md` | Solution Architecture Design — component architecture, data model, workflow orchestration, security |

## Repository Structure

```
vibe-harness/
├── daemon/            # Nitro HTTP server: API, task lifecycle, sandbox mgmt, SQLite via Drizzle
├── gui/               # Tauri + React desktop app
├── shared/            # TypeScript types/contracts shared between daemon and GUI
├── docs/              # Design documents (SRD, SAD)
│   ├── SRD.md
│   ├── SAD.md
│   ├── SRD.pdf
│   └── SAD.pdf
├── package.json       # npm workspaces root
├── LICENSE
└── README.md
```

## Core Domain Concepts

- **Project** — A registered local git repository
- **Task** — A single AI agent execution in a sandbox
- **Workflow Template** — A reusable multi-stage pipeline definition (e.g., plan → implement → review → commit)
- **Workflow Run** — One execution of a template against a project
- **Review** — A human checkpoint: view diff, add comments, approve or request changes
- **Split Execution** — A workflow stage that fans out into parallel child workflows, each in its own worktree, merged back on completion

## Target Platforms

- macOS (primary)
- Linux (secondary)
- Windows: not currently targeted

## Prerequisites

- Docker Desktop with `sbx` support
- Git
- GitHub credentials (`gh auth` or `GITHUB_TOKEN`)
