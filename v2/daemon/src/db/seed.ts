/**
 * Idempotent seed: inserts built-in agent definitions and workflow templates
 * if they don't already exist.
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

// MCP bridge script injected into Docker sandbox (adapted from v1)
const MCP_BRIDGE_JS = `#!/usr/bin/env node
const { execSync } = require("child_process");
const readline = require("readline");

const API_BASE = process.env.VIBE_HARNESS_URL || "http://host.docker.internal:19423";
const RUN_ID = process.env.VIBE_RUN_ID || "";
const AUTH_TOKEN = process.env.VIBE_AUTH_TOKEN || "";

function callApi(path, body) {
  try {
    const authHeader = AUTH_TOKEN ? '-H "Authorization: Bearer ' + AUTH_TOKEN + '"' : '';
    const result = execSync(
      'curl -s -X POST "' + API_BASE + path + '" ' +
      '-H "Content-Type: application/json" ' +
      authHeader + ' ' +
      "-d '" + JSON.stringify(body).replace(/'/g, "'\\\\''") + "'",
      { encoding: "utf-8", timeout: 30000 }
    );
    try { return JSON.parse(result); }
    catch (e) { return { error: "API returned non-JSON: " + result.slice(0, 200) }; }
  } catch (e) {
    return { error: "curl failed: " + e.message.slice(0, 200) };
  }
}

const TOOLS = [
  {
    name: "propose_task",
    description: "Propose an independent sub-task for parallel execution. Each proposal becomes a separate agent run in its own sandbox. Provide a clear title, description of what to implement, and which files are affected.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the sub-task" },
        description: { type: "string", description: "Detailed description of what to implement. Must be self-contained — the sub-task agent won't have context from other proposals." },
        affectedFiles: { type: "array", items: { type: "string" }, description: "List of file paths this task will create or modify" },
        dependsOn: { type: "array", items: { type: "string" }, description: "Titles of other proposals this depends on (empty if independent)" }
      },
      required: ["title", "description"]
    }
  },
  {
    name: "get_plan",
    description: "Retrieve the approved implementation plan from the previous stage.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_proposals",
    description: "List all proposals created so far in this session.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "delete_proposal",
    description: "Delete a proposal by its ID.",
    inputSchema: {
      type: "object",
      properties: { proposalId: { type: "string", description: "ID of the proposal to delete" } },
      required: ["proposalId"]
    }
  },
  {
    name: "get_project_tree",
    description: "Browse the project file structure. Returns tracked files respecting .gitignore.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Subdirectory to list (relative to project root). Omit for full tree." },
        maxDepth: { type: "integer", description: "Maximum directory depth to include." }
      }
    }
  }
];

function handleToolCall(name, args) {
  if (name === "echo_tool") return { content: [{ type: "text", text: "Echo: " + args.message }] };
  if (name === "get_time") return { content: [{ type: "text", text: "Time: " + new Date().toISOString() }] };
  const result = callApi("/api/mcp/tool", { tool: name, arguments: args, runId: RUN_ID });
  if (result.error) return { content: [{ type: "text", text: "Error: " + result.error }], isError: true };
  return result;
}

function jsonrpc(id, result) { return JSON.stringify({ jsonrpc: "2.0", id, result }); }
function jsonrpcError(id, code, message) { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }); }

function handleMessage(msg) {
  if (msg.method === "initialize") return jsonrpc(msg.id, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vibe-harness-bridge", version: "0.2.0" } });
  if (msg.method === "notifications/initialized") return null;
  if (msg.method === "tools/list") return jsonrpc(msg.id, { tools: TOOLS });
  if (msg.method === "tools/call") { const { name, arguments: args } = msg.params; return jsonrpc(msg.id, handleToolCall(name, args || {})); }
  if (msg.method === "ping") return jsonrpc(msg.id, {});
  return jsonrpcError(msg.id, -32601, "Method not found: " + msg.method);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(data) { if (data) process.stdout.write(data + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  try { send(handleMessage(JSON.parse(line))); }
  catch (e) { send(jsonrpcError(null, -32700, "Parse error: " + e.message)); }
});
rl.on("close", () => process.exit(0));
process.stderr.write("[vibe-mcp-bridge] Started (run=" + RUN_ID + ")\\n");
`;

const COPILOT_CLI_AGENT = {
  name: 'Copilot CLI',
  type: 'copilot_cli',
  commandTemplate: 'copilot',
  dockerImage: 'vibe-harness/copilot:latest',
  dockerfile: `# Custom sandbox template for vibe-harness
# Extends the official Copilot CLI sandbox with development tools.
#
# Build: docker build -t vibe-harness/copilot:latest -f Dockerfile .

FROM docker/sandbox-templates:copilot

USER root

# Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_25.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && npm install -g pnpm typescript tsx \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*

USER agent

# uv + Python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN $HOME/.local/bin/uv python install 3.14
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# Vibe Harness MCP bridge — stdio MCP server for split proposals
RUN cat > /home/agent/vibe-mcp-bridge.js << 'MCPEOF'
` + MCP_BRIDGE_JS + `
MCPEOF
`,
  description: 'GitHub Copilot CLI — built-in default agent',
  supportsStreaming: true,
  supportsContinue: true,
  supportsIntervention: true,
  outputFormat: 'acp',
  isBuiltIn: true,
} as const;

const PLAN_PROMPT = `Analyze the codebase and create a detailed implementation plan for the requested changes. Do not make any code changes.

Task:
{{description}}

Planning process:
- Explore the existing codebase to understand the architecture, patterns, and conventions already in use.
- Identify all files and modules that need to be created or modified.
- Consider edge cases, error handling, and potential impacts on existing functionality.

Plan format:
- Start with a brief summary of the approach.
- Break the work into clear, ordered steps. Each step should describe what to change, where, and why.
- Call out any risks, open questions, or decisions that need human input before implementation begins.
- Keep the plan concise and actionable — the implementer should be able to follow it without further clarification.`;

const IMPLEMENT_PROMPT = `Implement all changes described in the plan from the previous stage.

Task:
{{description}}

Principles:
- KISS — prefer the simplest solution that works. Avoid unnecessary indirection or cleverness.
- DRY — extract shared logic into well-named, reusable abstractions. When you see a repeated pattern, find the right abstraction for it.
- YAGNI — only build what the plan asks for. No speculative features or premature generalization.
- Separation of concerns — keep distinct responsibilities in separate modules/functions. Follow the project's existing architectural boundaries.

Guidelines:
- Follow the plan step by step. If something in the plan seems wrong or impossible, implement what you can and note the issue clearly.
- Match the codebase's existing style, patterns, and conventions.
- Write small, focused functions with clear names. Code should be self-documenting — add comments only when the "why" isn't obvious.
- All functions should have a short 'docstring' describing their purpose and operation.
- Handle error cases and edge cases appropriately.
- If the project has existing tests, add or update tests for your changes.
- After finishing, verify your changes compile/build successfully.
- Do not commit at this stage.`;

const REVIEW_PROMPT = `Review the implementation from the previous stage against the original plan. Do not make any code changes.

Task:
{{description}}

Process:
- Use sub-agents to perform the review. Launch at least two review agents in parallel using different models for diverse perspectives.
- Each sub-agent should review the full diff and report issues.
- Synthesize the sub-agent findings into a single consolidated review. Deduplicate overlapping findings and resolve any contradictions.

Review checklist (for sub-agents):
- Verify all planned steps were implemented completely and correctly.
- Check for bugs, logic errors, and unhandled edge cases.
- Look for security issues — injection, leaks, unsafe defaults.
- Evaluate adherence to KISS, DRY, YAGNI, and separation of concerns.
- Confirm the code matches the project's existing style and conventions.
- Check that all functions have clear names and docstrings.
- Run the build/lint commands and report any failures.

Output format:
- Start with a short summary: is the implementation ready to ship, or does it need changes?
- List any issues found, grouped by severity (critical / minor / nit).
- For each issue, explain what's wrong and suggest a concrete fix.
- If everything looks good, say so — don't invent problems.`;

const FIX_PROMPT = `Address all issues identified in the review from the previous stage. Do not make changes beyond what the review requested.

Process:
- Work through the review findings by severity: critical first, then minor, then nits.
- For each issue, apply the suggested fix or an equivalent solution that addresses the underlying concern.
- If a review finding is incorrect or would make the code worse, skip it and explain why.
- Use subagents generously to implement the changes.

Guidelines:
- Maintain the same KISS, DRY, YAGNI, and separation of concerns principles from the implementation stage.
- Verify the build/lint commands pass after all fixes are applied.
- Do not commit at this stage.`;

const COMMIT_PROMPT = `Prepare the branch for merge. This is the final step before the changes are merged to main.

Tasks:
1. Review all uncommitted changes with \`git status\` and \`git diff\`.
2. Stage only the files relevant to this task — do not stage unrelated changes, build artifacts, or temporary files.
3. Squash the branch history into a single clean commit:
   - Use \`git log --oneline main..HEAD\` to see existing commits on this branch.
   - If there are multiple commits, use \`git reset --soft main\` to unstage all changes, then re-stage and commit as one.
   - If there is only one commit, amend it with the proper message.
4. Write a clear, conventional commit message:
   - First line: short summary (max 72 chars), imperative mood (e.g., "feat(admin): add IP allowlist to CMS admin panel")
   - The summary MUST start with one of these type prefixes: \`feat\`, \`improvement\`, \`docs\`, \`chore\`, \`cicd\`, \`test\`, \`refactor\`.
   - If the change is scoped to a specific subsection of the codebase, include it in parentheses after the type (e.g., \`feat(auth):\`, \`refactor(api):\`). Omit the parentheses if the change is broad or unscoped.
   - Blank line, then a body explaining what changed and why (2-5 lines)
   - Do NOT include "vibe-harness" or task IDs in the message
5. Verify the final state: \`git log --oneline -3\` and \`git diff --stat main..HEAD\`.
6. Do not push or merge — that is handled automatically.`;

const WORKFLOW_TEMPLATES = [
  {
    name: 'Quick Run',
    description: 'Single-stage execution — run the agent once with no review gate.',
    stages: JSON.stringify([
      {
        name: 'execute',
        promptTemplate: '{{description}}',
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
  {
    name: 'Plan & Implement',
    description: 'Three stages: plan, implement, then commit the result.',
    stages: JSON.stringify([
      {
        name: 'plan',
        splittable: true,
        promptTemplate: PLAN_PROMPT,
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'implement',
        promptTemplate: IMPLEMENT_PROMPT,
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'commit',
        promptTemplate: COMMIT_PROMPT,
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
  {
    name: 'Full Review',
    description:
      'Five stages: plan, implement, review, fix, and commit (SRD FR-W11).',
    stages: JSON.stringify([
      {
        name: 'plan',
        splittable: true,
        promptTemplate: PLAN_PROMPT,
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'implement',
        promptTemplate: IMPLEMENT_PROMPT,
        reviewRequired: false,
        autoAdvance: true,
        freshSession: true,
      },
      {
        name: 'review',
        promptTemplate: REVIEW_PROMPT,
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
      },
      {
        name: 'fix',
        promptTemplate: FIX_PROMPT,
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'commit',
        promptTemplate: COMMIT_PROMPT,
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
] as const;

// ─── Default global splitter prompt template ──────────────────────────
//
// Used by the ad-hoc split flow. Variables interpolated at decision time:
//   {{description}}    — the workflow run's original description
//   {{extra}}          — user-supplied "extra description" from the modal
//
// Operator can edit this in Settings.
const DEFAULT_SPLITTER_PROMPT_TEMPLATE = `## Split Task

The user reviewed the previous stage and chose to split the remaining work
into independent parallel sub-tasks.

### Original task

{{description}}

### Extra guidance from the user

{{extra}}

## Your job

Do NOT implement any code changes. Your ONLY job is to decompose the work
into sub-tasks using the MCP tools provided.

You have MCP tools available:
- **propose_task** — create a sub-task proposal (title, description,
  affectedFiles, dependsOn).
- **get_plan** — retrieve the approved plan/output from the previous stage.
- **list_proposals** — list proposals you've already created.
- **delete_proposal** — remove a proposal by id.
- **get_project_tree** — browse the project file structure.

## Process

1. Call **get_plan** to retrieve the prior-stage output you are splitting.
2. Call **get_project_tree** if you need to understand the layout.
3. Identify groups of work that can be done independently in parallel.
4. For each group, call **propose_task** with a clear title, a detailed
   self-contained description (the sub-task agent will NOT see the other
   proposals), the affected files, and any dependencies (by title).
5. Call **list_proposals** to verify, and delete + recreate as needed.

## Guidelines

- Each proposal must stand alone — include enough context for an agent to
  implement it without seeing other proposals.
- Minimize file overlap between proposals.
- Mark dependencies explicitly: if proposal B needs APIs from A, add A's
  title to B's dependsOn list.
- Aim for 2–8 proposals. If the work is small enough for one agent,
  create a single proposal.
`;

export function seed(db: BetterSQLite3Database<typeof schema>) {
  // ── Agent definitions ───────────────────────────────────────────────
  const existingAgent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.name, COPILOT_CLI_AGENT.name))
    .get();

  if (!existingAgent) {
    db.insert(schema.agentDefinitions).values(COPILOT_CLI_AGENT).run();
  } else {
    // Update Dockerfile if it changed (e.g., MCP bridge was added)
    if (existingAgent.dockerfile !== COPILOT_CLI_AGENT.dockerfile) {
      db.update(schema.agentDefinitions)
        .set({ dockerfile: COPILOT_CLI_AGENT.dockerfile })
        .where(eq(schema.agentDefinitions.name, COPILOT_CLI_AGENT.name))
        .run();
    }
  }

  // ── Workflow templates ──────────────────────────────────────────────
  for (const tmpl of WORKFLOW_TEMPLATES) {
    const existing = db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.name, tmpl.name))
      .get();

    if (!existing) {
      db.insert(schema.workflowTemplates).values(tmpl).run();
    } else if (
      existing.isBuiltIn &&
      (existing.stages !== tmpl.stages || existing.description !== tmpl.description)
    ) {
      // Refresh built-in templates when their definitions change so users
      // pick up updated prompts without manual intervention.
      db.update(schema.workflowTemplates)
        .set({ stages: tmpl.stages, description: tmpl.description })
        .where(eq(schema.workflowTemplates.name, tmpl.name))
        .run();
    }
  }

  // ── Strip legacy `type` field from any user-defined templates ───────
  // The split-execution redesign removed StageType. Any pre-existing
  // user-defined template still carrying `type: 'standard' | 'split'`
  // gets it stripped here. `type: 'split'` is rewritten as
  // `splittable: true` so the operator's intent is preserved.
  const allTemplates = db.select().from(schema.workflowTemplates).all();
  for (const tmpl of allTemplates) {
    let stages: any;
    try {
      stages = JSON.parse(tmpl.stages);
    } catch {
      continue;
    }
    if (!Array.isArray(stages)) continue;
    let dirty = false;
    const cleaned = stages.map((s: any) => {
      if (s && typeof s === 'object' && 'type' in s) {
        const { type, ...rest } = s;
        dirty = true;
        if (type === 'split' && rest.splittable === undefined) {
          return { ...rest, splittable: true };
        }
        return rest;
      }
      return s;
    });
    if (dirty) {
      db.update(schema.workflowTemplates)
        .set({ stages: JSON.stringify(cleaned) })
        .where(eq(schema.workflowTemplates.id, tmpl.id))
        .run();
    }
  }

  // ── Seed global app settings for ad-hoc split execution ─────────────
  const settingsToSeed: Array<{ key: string; value: string }> = [
    { key: 'defaultSplitterPromptTemplate', value: DEFAULT_SPLITTER_PROMPT_TEMPLATE },
    { key: 'defaultPostSplitStages', value: JSON.stringify([]) },
  ];
  for (const s of settingsToSeed) {
    const existing = db.select().from(schema.settings)
      .where(eq(schema.settings.key, s.key)).get();
    if (!existing) {
      db.insert(schema.settings).values({
        key: s.key,
        value: s.value,
        updatedAt: new Date().toISOString(),
      }).run();
    }
  }
}
