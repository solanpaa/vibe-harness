# AGENTS.md — Vibe Harness

## What This Is

Vibe Harness is a desktop-native orchestrator for AI coding agents (GitHub Copilot CLI, Claude Code, Gemini CLI). It runs agents in isolated Docker sandboxes against local git repositories, managing multi-stage workflows with human review gates, git worktree isolation, and parallel execution.

Users define a task ("add OAuth to the API"), the system launches an AI agent in a sandbox, streams its output in real-time, and presents the resulting code changes for human review. Workflows chain multiple stages (plan → implement → review → commit) with session continuity, so the agent remembers context across stages.

## Current State: v1 → v2 Transition

This repository is in a transitional state between two major versions.

### v1 (in `v1/`)

A working Next.js browser application. Functional but with known limitations:
- Painful npm-based installation
- Browser UI limits multi-window workflows
- Organic codebase with architectural debt
- No durable workflow persistence across restarts

**v1 is reference-only — not under active development.**

### v2 (being built)

A full rewrite with a fundamentally different architecture:

| Component | Technology | Status |
|-----------|-----------|--------|
| **Daemon** | Node.js + Hono + Nitro + `use workflow` | Design complete |
| **GUI** | Tauri 2.0 + React + Vite + Streamdown | Design complete |
| **CLI** | Post-MVP | Planned |
| **Shared types** | TypeScript workspace package | Planned |

Key architectural changes from v1:
- **Daemon + GUI separation** — daemon owns all state and logic; GUI is a thin presentation client
- **Durable workflows** — Vercel's `use workflow` SDK provides event-sourced, resumable orchestration that survives daemon restarts at review gates
- **Native desktop app** — Tauri replaces the browser; native multi-window support for concurrent diff review and output monitoring
- **Single-binary distribution** — no `npm install` for end users

### Design Documents (in `docs/`)

| Document | Description |
|----------|-------------|
| `SRD.md` | Solution Requirements Description — 80+ functional and non-functional requirements |
| `SAD.md` | Solution Architecture Design — component architecture, data model, workflow orchestration, security |

Both reviewed by multiple AI models (GPT-5.4, Claude Opus 4.5, Claude Opus 4.6) with all identified gaps resolved.

### Workflow Spike (in `workflow-spike/`)

A proof-of-concept validating the `use workflow` SDK with Hono. All 5 critical scenarios pass: human-in-the-loop hooks, sequential pipelines, parallel fan-out, durability across restart, and cancellation.

## Repository Structure

```
vibe-harness/
├── docs/              # v2 design documents (SRD, SAD)
│   ├── SRD.md         # Solution Requirements Description
│   ├── SAD.md         # Solution Architecture Design
│   ├── SRD.pdf        # PDF for offline review
│   └── SAD.pdf
├── v1/                # Original Next.js app (reference only)
│   ├── src/           # App source (services, API routes, UI)
│   ├── docker/        # Sandbox Dockerfile
│   └── ...
├── workflow-spike/    # use workflow SDK proof-of-concept
├── LICENSE
└── README.md
```

When v2 reaches feature parity, `v1/` will be removed and `v2/` contents promoted to root.

## Core Domain Concepts

- **Project** — A registered local git repository
- **Task** — A single AI agent execution in a Docker sandbox
- **Workflow Template** — A reusable multi-stage pipeline definition (e.g., plan → implement → review → commit)
- **Workflow Run** — One execution of a template against a project
- **Review** — A human checkpoint: view diff, add comments, approve or request changes
- **Split Execution** — A workflow stage that fans out into parallel child workflows, each in its own worktree, merged back on completion

## Target Platforms

- macOS (primary)
- Linux (secondary)
- Windows: not currently targeted

## Prerequisites

- Docker Desktop with `docker sandbox` support
- Git
- GitHub credentials (`gh auth` or `GITHUB_TOKEN`)
