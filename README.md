# Vibe Harness

AI coding agent orchestrator — run Copilot CLI, Claude Code, and Gemini in Docker sandboxes with workflow pipelines, code reviews, and parallel execution.

## Quick Start

Run directly from GitHub with a single command:

```bash
npx github:jannesolanpaa/vibe-harness
```

This installs dependencies, builds the app on first run, and starts the server at [http://localhost:3000](http://localhost:3000).

### Options

```bash
npx github:jannesolanpaa/vibe-harness --port 4000     # Custom port
npx github:jannesolanpaa/vibe-harness --no-open        # Don't open browser
npx github:jannesolanpaa/vibe-harness --data-dir ~/my-data  # Custom data dir
```

### Global Install

For frequent use without the `npx` overhead:

```bash
npm install -g github:jannesolanpaa/vibe-harness
vibe-harness
```

### Pin a Version

```bash
npx github:jannesolanpaa/vibe-harness#v0.2.0   # tagged release
npx github:jannesolanpaa/vibe-harness#main      # latest main
```

## Prerequisites

The CLI checks for these on startup:

- **Node.js >= 20**
- **Docker Desktop** (running)
- **git**
- **GitHub CLI** (`gh`) — authenticated
- **Copilot CLI** (`copilot`)

## Data Directory

Vibe Harness stores its database at `~/.vibe-harness/vibe-harness.db` by default. Override with `--data-dir` or the `DATABASE_URL` environment variable (use `file:` prefix, e.g. `DATABASE_URL=file:/path/to/db.sqlite`).

## Development

```bash
npm install
npm run dev          # Dev server on :3000
npm run build        # Production build
npm run lint         # ESLint
```

The dev server uses `./vibe-harness.db` in the project root. Delete it to reset.

## Custom Sandbox Image

Vibe Harness uses a custom Docker sandbox template that extends the official Copilot CLI image with pre-installed development tools:

- **Node.js 25** (with npm)
- **pnpm** (via corepack)
- **Python 3.14**
- **uv / uvx** (Astral Python package manager)

### Building the image

```bash
./docker/build.sh
# or manually:
docker build -t vibe-harness/copilot:latest -f docker/Dockerfile.copilot docker/
```

The CLI will detect if the image is missing and build it automatically on first run.

### Rebuilding after changes

Edit `docker/Dockerfile.copilot` and re-run the build script. Delete `~/.vibe-harness/vibe-harness.db` if you need to re-seed the default agent definition, or update the agent's `dockerImage` field via the API.
