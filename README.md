# Vibe Harness v2

Desktop application for orchestrating AI coding agents (Copilot CLI, Claude Code, Gemini) in Docker sandboxes. Tasks run agents against git repositories with optional multi-stage workflow pipelines (plan → implement → review).

## Architecture

- **daemon/** — Nitro HTTP server: API, task lifecycle, sandbox management, SQLite via Drizzle
- **gui/** — Tauri + React desktop app: project/task UI, live streaming, review interface
- **shared/** — TypeScript types and contracts shared between daemon and GUI

## Prerequisites

- **Node.js** 20+
- **Docker** (with `docker sandbox` support)
- **Git**
- **Rust / Cargo** (for GUI — install via [rustup](https://rustup.rs))

## Quick Start

```bash
# Install all workspace dependencies
npm install

# Start the daemon (API server on :3000)
npm run dev

# In another terminal — start the GUI
npm run dev:gui
```

## Scripts

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `npm run dev`      | Start daemon dev server              |
| `npm run dev:gui`  | Start Tauri GUI in dev mode          |
| `npm run build`    | Production build (all workspaces)    |
| `npm run test`     | Run tests (all workspaces)           |
| `npm run typecheck`| Type-check (all workspaces)          |

## Production Build

```bash
# Daemon
cd daemon && bash scripts/build.sh
# Output: daemon/.output/server/index.mjs

# GUI (Vite frontend)
cd gui && npm run build
```

## Docs

See [../docs/](../docs/) for detailed design documents.
