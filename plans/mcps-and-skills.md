# v2 Plan — Agent Features (MCP Servers + Skills)

## Problem

Give users a first-class way to extend what the Copilot CLI agent can do inside sandboxes by managing two kinds of "features":

1. **MCP servers** — HTTP or local MCP servers injected via `copilot --additional-mcp-config @/tmp/vibe-mcp-config.json`, with network-allowlist auto-extension.
2. **Skills** — Directories of `SKILL.md` + optional scripts, mounted into the sandbox so Copilot auto-discovers them.

Both must be manageable in the GUI, selectable per-run, and behave deterministically across daemon restarts (workflow durability).

## Proposed approach

A **Features** subsystem composed of: (a) a daemon-managed library with global + per-project scope, (b) project-level defaults, (c) per-run selection via a New Run *Advanced* section, (d) a per-run snapshot that makes runs immune to mid-flight library edits, and (e) a runtime injector that materializes selections into each sandbox at create time.

Critical design decisions (post rubber-duck):

- **Full content snapshot for everything**, including secrets. `credential_ref` mode still snapshots an encrypted value + KMS key version at run start — the credential entry itself is not re-read at resume time. Runs stay immutable against library/credential edits.
- **Mount skills at both `/home/agent/.copilot/skills` and `/home/agent/.agents/skills`** (symlink one to the other) to guarantee Copilot discovery while keeping the agent-agnostic path forward-compatible.
- **In-repo project skills** in the worktree (`.github/skills`, `.agents/skills`) are left to Copilot's auto-discovery. The daemon scans them at run start and *warns on name collisions* with enabled library skills (repo wins per upstream precedence).
- **`allowed-tools: shell|bash` is treated as high-risk.** A skill with those tools is only enabled after an explicit per-skill "I trust this" toggle; every run that uses such a skill writes a `credentialAuditLog`-style entry. Import never silently preserves the field.
- **Reserve `vibe-harness` as an MCP server name** — collisions with the Dockerfile-baked bridge are rejected at save/import time.
- **Local MCP import compatibility check.** Host `command` paths and binaries rarely exist in the sandbox image; imported local MCPs are marked `needs-review` and blocked from selection until the user confirms they are compatible (or edits them).
- **Normalized join tables**, not JSON-ID arrays, for project defaults. FK `ON DELETE CASCADE` for defaults; runs remain safe because of snapshotting.
- **Run request payload distinguishes** `undefined` (inherit project defaults) from `[]` (explicit empty override).
- **Snapshot build is one DB transaction** with a serializable read so selections, secrets, and skills are captured atomically.
- **MVP skill editor is intentionally simple**: frontmatter form + Markdown body + file upload/delete. Multi-file in-GUI authoring is deferred.
- **Per-stage overrides deferred** to post-MVP; snapshot schema shaped to allow adding `perStage: { [stageIndex]: featureSet }` later without migration pain.

## Data model (additions)

### Tables
- `mcp_servers`
  - `id`, `projectId` (nullable = global, FK `projects` `ON DELETE CASCADE`), `name` (UNIQUE per scope; reserved names rejected), `type` (`http` | `local`), `url`, `command`, `argsJson`, `envJson`, `headersJson`, `toolsAllowlistJson` (default `["*"]`), `description`, `compatibility` (`ok` | `needs_review`), `createdAt`, `updatedAt`.
- `mcp_server_secrets`
  - `id`, `mcpServerId` (FK CASCADE), `slot` (e.g., `header:Authorization`, `env:GITHUB_TOKEN`), `mode` (`inline_encrypted` | `credential_ref`), `encryptedValue` (nullable), `kmsKeyVersion`, `credentialEntryId` (nullable, FK `credential_entries`).
- `skills`
  - `id`, `projectId` (nullable = global, FK CASCADE), `name` (kebab-case, UNIQUE per scope), `frontmatterJson`, `body` (Markdown), `allowedToolsRisky` (bool: includes `shell`/`bash`), `trustAcknowledged` (bool, gating selection when risky), `createdAt`, `updatedAt`.
- `skill_files`
  - `id`, `skillId` (FK CASCADE), `relPath`, `contentBlob`, `mode` (Unix perms), `size`.
- `project_feature_defaults`
  - `projectId` (FK CASCADE), `featureType` (`mcp_server` | `skill`), `featureId`, PRIMARY KEY `(projectId, featureType, featureId)`, FK CASCADE on feature deletion.

### Extensions
- `workflow_runs.featuresSnapshotJson` — full resolved snapshot (see schema below).
- `credentialAuditLog` — reused to record: feature-trust enabled, risky-skill run usage, import events, MCP secret resolution at run start.

### `featuresSnapshotJson` shape (v1, per-stage hook reserved)
```jsonc
{
  "version": 1,
  "mcpServers": [
    {
      "id": "...", "versionHash": "...", "name": "...", "type": "http",
      "url": "...", "command": null, "args": [], "env": {...},
      "headers": {...}, "toolsAllowlist": ["*"],
      "secrets": [
        { "slot": "header:Authorization",
          "encryptedValue": "...", "kmsKeyVersion": "k3" }
      ]
    }
  ],
  "skills": [
    {
      "id": "...", "versionHash": "...", "name": "...",
      "frontmatter": {...}, "body": "...",
      "files": [{ "relPath": "run.sh", "contentHash": "...", "mode": 0o755 }],
      "risky": true
    }
  ],
  "perStage": null // reserved; MVP always null
}
```
Skill file contents are copied to `<dataDir>/runs/<runId>/skills/…` at snapshot time; the snapshot references them by content-hash path.

## Runtime injection

Order at sandbox create (no code changes to existing credentials flow):

1. Materialize skill tree to `<dataDir>/runs/<runId>/skills/<skill-name>/SKILL.md` (+ attached files with correct mode).
2. Add two RO bind mounts via the existing `hostDirMounts` pathway:
   - `<dataDir>/runs/<runId>/skills` → `/home/agent/.agents/skills`
   - same source → `/home/agent/.copilot/skills` (dual-mount ensures Copilot discovery).
3. After create, scan worktree for `.github/skills`, `.agents/skills`, `.claude/skills`; any repo-skill name equal to a snapshot skill name emits a `WARN` ACP event and an audit log entry (repo wins per upstream behavior).
4. Resolve MCP secrets: decrypt snapshot values with the recorded KMS key version; fail fast with a clear error if the key is unavailable. Build `{ mcpServers: {…} }` JSON, stream into sandbox at `/tmp/vibe-mcp-config.json` via `docker sandbox exec -i … tee`.
5. Pass `--additional-mcp-config @/tmp/vibe-mcp-config.json` to `copilot --acp …`. The baked `/home/agent/.copilot/mcp-config.json` (`vibe-harness` bridge) is preserved because Copilot merges and we reject user configs that reuse the `vibe-harness` name.
6. Extend sandbox network allowlist with every HTTP MCP hostname (mirrors v1). If project policy is `localhost_only` and any HTTP MCP is non-local, either refuse to start with actionable error or auto-upgrade to `allowlist` policy depending on a per-project setting (default: refuse).

## UX

### Settings → "Features" page (two tabs)

**MCP Servers**
- List columns: scope pill (Global / Project name), name, type, compatibility badge, trust state, default-in (count of projects that default it on), actions.
- Actions: `Add server`, `Import from host config` (parses `~/.copilot/mcp-config.json`; one row per discovered server with scope picker + per-server import toggle; local MCPs get a "Likely incompatible — review" banner).
- Editor form:
  - Type (`http` / `local`), URL or command + args, env, headers, tools allowlist.
  - Secrets: repeater of slot rows; each slot has a toggle `Inline value` / `Use credential` and appropriate input.
  - "Test in sandbox" button: spawns a throwaway sandbox, injects config, runs `copilot --list-mcp` style handshake; reports success/failure and any stderr.
- Reserved-name validation (`vibe-harness` blocked).
- Duplicate / delete. Delete checks project defaults and warns.

**Skills**
- List columns: scope pill, name, description (frontmatter), risky-badge (if `allowed-tools` contains `shell`/`bash`), trust state, default-in, actions.
- Editor form:
  - Frontmatter fields: name (kebab-case), description, license (optional), `allowed-tools` checklist (`shell`, `bash`, others free-form).
  - Markdown body editor (Streamdown).
  - Attached files: upload / delete / rename / chmod-executable toggle.
  - If risky: a "Trust this skill" switch is required before it becomes selectable; turning it on logs an audit entry.
- Import: pick a host directory containing `SKILL.md`; daemon copies files into the library, preserves executable bit, clears any `allowed-tools: shell|bash` (user must re-enable explicitly and flip trust).
- Export: zip of the skill tree.
- Preview: renders the serialized `SKILL.md`.

### Project Settings → new "Defaults" section
- Two multi-selects: "Default MCP servers" and "Default skills" (both pulling from Global ∪ this-project scope). Risky / incompatible items visible but blocked from selection until resolved.

### New Run dialog → "Advanced" (collapsible)
- Pre-populated from project defaults.
- Two multi-selects with scope pills and a "Reset to defaults" link.
- Collapsed state shows summary: `3 MCP • 2 skills (1 risky)`.
- Repo-skill collision warning appears inline.
- Run request payload:
  - `mcpServerIds?: string[] | null` — omit = inherit project defaults; `[]` = explicit none.
  - `skillIds?: string[] | null` — same semantics.

## API (shape)

- `GET /api/mcp-servers?projectId=&scope=` · `POST /api/mcp-servers` · `GET|PATCH|DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/import` — body `{ source: 'hostConfig' | 'inlineJson', path?, json? }` → returns discovered candidates; actual creation is a subsequent `POST /api/mcp-servers` per accepted row.
- `POST /api/mcp-servers/:id/test` — runs the sandbox-based test.
- `GET /api/skills?projectId=` · `POST /api/skills` · `GET|PATCH|DELETE /api/skills/:id` · `PATCH /api/skills/:id/trust`
- `GET|POST|DELETE /api/skills/:id/files/:relPath`
- `POST /api/skills/import` · `GET /api/skills/:id/export`
- `GET|PUT /api/projects/:id/feature-defaults` — full replace payload `{ mcpServerIds, skillIds }`.
- `POST /api/runs` — extended body: `mcpServerIds?`, `skillIds?` (tri-state).

## Security / audit
- `allowed-tools` containing `shell`/`bash` is the only gated flag. Trust is per-skill and resets on import or on body edit that changes frontmatter.
- Every risky-skill run writes `risky_skill_used` to `credentialAuditLog` with `{skillId, runId, projectId}`.
- MCP secret resolution failure (key missing / credential referenced from snapshot via `credential_ref` path that somehow degraded) aborts the run with a specific error code.
- Import paths are confined to the user's home; symlink escapes are rejected.

## Open questions / deferred
- Per-stage overrides (post-MVP) — schema already reserves `perStage`.
- Skill marketplace / sharing — out of scope.
- Non-Copilot agents (Claude Code / Gemini) — `/home/agent/.agents/skills` mount is already correct; MCP plumbing will need agent-specific CLI flags when those agents are added.
- Telemetry on which features actually get loaded by Copilot during a run — nice-to-have, depends on ACP events.

## Todos

Tracked in SQL.
