import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { startTask } from "./task-manager";
import { transitionTask, transitionWorkflowRun } from "@/lib/state-machine";
import { generateTitle } from "@/lib/services/title-generator";
import { buildStagePrompt } from "./workflow-config";
import type { WorkflowStage } from "@/types/domain";

// Re-export from workflow-config for backward compatibility
export { getStageConfig, buildStagePrompt } from "./workflow-config";

/**
 * Create a workflow template with stages.
 */
export function createWorkflowTemplate(input: {
  name: string;
  description?: string;
  stages: WorkflowStage[];
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const template = {
    id: uuid(),
    name: input.name,
    description: input.description || null,
    stages: JSON.stringify(input.stages),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.workflowTemplates).values(template).run();
  return { ...template, stages: input.stages };
}

/**
 * Start a workflow run — executes the first stage.
 * taskDescription is the user's high-level feature/task description.
 */
export async function startWorkflowRun(input: {
  workflowTemplateId: string;
  projectId: string;
  taskDescription: string;
  agentDefinitionId?: string | null;
  credentialSetId?: string | null;
  model?: string | null;
  useWorktree?: boolean;
}) {
  const db = getDb();

  // Get the template
  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, input.workflowTemplateId))
    .get();

  if (!template) throw new Error("Workflow template not found");

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  if (stages.length === 0) throw new Error("Workflow has no stages");

  const firstStage = stages[0];
  const now = new Date().toISOString();

  // Create workflow run with task description — starts as "pending"
  const runId = uuid();
  db.insert(schema.workflowRuns)
    .values({
      id: runId,
      workflowTemplateId: template.id,
      projectId: input.projectId,
      taskDescription: input.taskDescription,
      status: "pending",
      currentStage: firstStage.name,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Transition: pending → running via state machine
  await transitionWorkflowRun(runId, { type: "START", firstStageName: firstStage.name });

  // Fire-and-forget title generation for the workflow run
  if (input.taskDescription) {
    generateTitle(input.taskDescription).then((title) => {
      if (title) {
        db.update(schema.workflowRuns)
          .set({ title })
          .where(eq(schema.workflowRuns.id, runId))
          .run();
      }
    }).catch((err) => {
      console.warn("Workflow run title generation failed:", err);
    });
  }

  // Get the project for the local path
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();

  if (!project) throw new Error("Project not found");

  // Get agent — use provided, stage-specific, or first available
  const agentId = input.agentDefinitionId || firstStage.agentDefinitionId;
  const agent = agentId
    ? db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, agentId))
        .get()
    : db.select().from(schema.agentDefinitions).get();

  if (!agent) throw new Error("No agent definition found");

  // Build combined prompt: task description + stage instructions
  const prompt = buildStagePrompt(input.taskDescription, firstStage);

  // Create and start task for the first stage
  const taskId = uuid();
  db.insert(schema.tasks)
    .values({
      id: taskId,
      projectId: input.projectId,
      workflowRunId: runId,
      stageName: firstStage.name,
      agentDefinitionId: agent.id,
      credentialSetId: input.credentialSetId || null,
      sandboxId: null,
      status: "pending",
      prompt,
      model: input.model || null,
      useWorktree: input.useWorktree !== false ? 1 : 0,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  const agentCommand = agent.commandTemplate || "copilot";

  // Set provisioning via state machine and launch in background
  await transitionTask(taskId, { type: "PROVISION" });

  Promise.resolve().then(() => {
    try {
      startTask({
        taskId,
        projectDir: project.localPath,
        agentCommand,
        dockerImage: agent.dockerImage,
        credentialSetId: input.credentialSetId,
        prompt,
        model: input.model,
        useWorktree: input.useWorktree,
      });
    } catch (e) {
      console.error(`[Workflow ${runId}] Failed to start first stage:`, e);
      transitionTask(taskId, { type: "FAIL" }).catch((e2) =>
        console.error(`[Workflow ${runId}] Also failed to mark task as FAIL:`, e2));
    }
  });

  return { runId, taskId, stageName: firstStage.name };
}

/** Get default workflow template (plan → implement → review → done) */
export function getDefaultWorkflowStages(): WorkflowStage[] {
  return [
    {
      name: "plan",
      type: "sequential" as const,
      promptTemplate: `Analyze the codebase and create a detailed implementation plan for the requested changes. Do not make any code changes.

Planning process:
- Explore the existing codebase to understand the architecture, patterns, and conventions already in use.
- Identify all files and modules that need to be created or modified.
- Consider edge cases, error handling, and potential impacts on existing functionality.

Plan format:
- Start with a brief summary of the approach.
- Break the work into clear, ordered steps. Each step should describe what to change, where, and why.
- Call out any risks, open questions, or decisions that need human input before implementation begins.
- Keep the plan concise and actionable — the implementer should be able to follow it without further clarification.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "implement",
      type: "sequential" as const,
      promptTemplate: `Implement all changes described in the plan from the previous stage.

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
- Do not commit at this stage.`,
      autoAdvance: true,
      reviewRequired: false,
      freshSession: true,
    },
    {
      name: "review",
      type: "sequential" as const,
      promptTemplate: `Review the implementation from the previous stage against the original plan. Do not make any code changes.

Process:
- Use sub-agents to perform the review. Launch at least two review agents in parallel using different models (gpt-5.4 and claude-opus-4.5) for diverse perspectives.
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
- If everything looks good, say so — don't invent problems.`,
      autoAdvance: true,
      reviewRequired: false,
      freshSession: false,
    },
    {
      name: "fix",
      type: "sequential" as const,
      promptTemplate: `Address all issues identified in the review from the previous stage. Do not make changes beyond what the review requested.

Process:
- Work through the review findings by severity: critical first, then minor, then nits.
- For each issue, apply the suggested fix or an equivalent solution that addresses the underlying concern.
- If a review finding is incorrect or would make the code worse, skip it and explain why.
- Use subagents generously to implement the changes.

Guidelines:
- Maintain the same KISS, DRY, YAGNI, and separation of concerns principles from the implementation stage.
- Verify the build/lint commands pass after all fixes are applied.
- Do not commit at this stage.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "commit",
      type: "sequential" as const,
      promptTemplate: `Prepare the branch for merge. This is the final step before the changes are merged to main.

Tasks:
1. Review all uncommitted changes with \`git status\` and \`git diff\`.
2. Stage only the files relevant to this task — do not stage unrelated changes, build artifacts, or temporary files.
3. Squash the branch history into a single clean commit:
   - Use \`git log --oneline main..HEAD\` to see existing commits on this branch.
   - If there are multiple commits, use \`git reset --soft main\` to unstage all changes, then re-stage and commit as one.
   - If there is only one commit, amend it with the proper message.
4. Write a clear, conventional commit message:
   - First line: short summary (max 72 chars), imperative mood (e.g., "Add IP allowlist to CMS admin panel")
   - Blank line, then a body explaining what changed and why (2-5 lines)
   - Do NOT include "vibe-harness" or task IDs in the message
5. Verify the final state: \`git log --oneline -3\` and \`git diff --stat main..HEAD\`.
6. Do not push or merge — that is handled automatically.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
  ];
}
export function getPlanAndSplitStages(): WorkflowStage[] {
  return [
    {
      name: "plan",
      type: "sequential" as const,
      promptTemplate: `Analyze the codebase and create a detailed implementation plan for the requested changes. Do not make any code changes.

Planning process:
- Explore the existing codebase to understand the architecture, patterns, and conventions already in use.
- Identify all files and modules that need to be created or modified.
- Consider edge cases, error handling, and potential impacts on existing functionality.

Plan format:
- Start with a brief summary of the approach.
- Break the work into clear, ordered steps. Each step should describe what to change, where, and why.
- Group related steps that could be worked on independently.
- Call out any dependencies between groups (e.g., "group B needs the types defined in group A").
- Call out any risks, open questions, or decisions that need human input before implementation begins.
- Keep the plan concise and actionable.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "split",
      type: "split" as const,
      promptTemplate: `IMPORTANT: Do NOT implement any code changes. Your ONLY job is to decompose the plan into sub-tasks using the MCP tools provided to you.

You have MCP tools for splitting work into parallel sub-tasks:
- propose_task: Create a sub-task proposal with title, description, affected files, and dependencies
- get_plan: Retrieve the approved implementation plan from the previous stage
- list_proposals: List all proposals you've created so far
- delete_proposal: Remove a proposal by ID
- get_project_tree: Browse the project file structure

Process:
1. Call get_plan to retrieve the approved implementation plan.
2. Call get_project_tree to understand the codebase layout.
3. Analyze the plan and identify groups of work that can be done independently.
4. For each group, call propose_task with:
   - A clear, specific title
   - A detailed description of exactly what to implement (the sub-task agent won't have the full plan)
   - The list of files that will be modified
   - Any dependencies on other proposals (by title)
5. Call list_proposals to verify your proposals look correct.
6. Delete and recreate any proposals that need adjustment.

Guidelines:
- Do NOT make any code changes yourself. Only create proposals.
- Each proposal should be self-contained enough that an agent can implement it without context from other proposals.
- Minimize file overlap between proposals — if two proposals touch the same file, consider merging them or clearly delineating which parts each handles.
- Include necessary context in each proposal's description (e.g., "The Task type is defined in src/types/domain.ts with fields X, Y, Z").
- Mark dependencies explicitly — if proposal B needs types/APIs created by proposal A, add A's title to B's dependsOn list.
- Aim for 2-8 proposals. If the plan is small enough for one agent, create a single proposal.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
  ];
}

/** Get "Direct Execute" stages — single implement stage for one-off tasks. */
export function getDirectExecuteStages(): WorkflowStage[] {
  return [
    {
      name: "implement",
      type: "sequential" as const,
      promptTemplate: `Execute the requested task. Follow the project's existing style and conventions.

Guidelines:
- Implement exactly what is requested.
- Match existing code patterns and naming conventions.
- Handle error cases appropriately.
- Verify the build passes after your changes.
- Do not commit.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "commit",
      type: "sequential" as const,
      promptTemplate: `Prepare the branch for merge. This is the final step before the changes are merged to main.

Tasks:
1. Review all uncommitted changes with \`git status\` and \`git diff\`.
2. Stage only the files relevant to this task — do not stage unrelated changes, build artifacts, or temporary files.
3. Squash the branch history into a single clean commit:
   - Use \`git log --oneline main..HEAD\` to see existing commits on this branch.
   - If there are multiple commits, use \`git reset --soft main\` to unstage all changes, then re-stage and commit as one.
   - If there is only one commit, amend it with the proper message.
4. Write a clear, conventional commit message:
   - First line: short summary (max 72 chars), imperative mood (e.g., "Add IP allowlist to CMS admin panel")
   - Blank line, then a body explaining what changed and why (2-5 lines)
   - Do NOT include "vibe-harness" or task IDs in the message
5. Verify the final state: \`git log --oneline -3\` and \`git diff --stat main..HEAD\`.
6. Do not push or merge — that is handled automatically.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
  ];
}
