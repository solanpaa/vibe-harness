// ---------------------------------------------------------------------------
// Launch Children Step (CDD-workflow §3.5)
//
// Creates a parallel group and launches independent child workflow runs.
// Each child gets its own sandbox + worktree; worktree creation is deferred
// to sessionManager.create() which uses parentWorktreeCommit stored on the
// child run record to branch from the correct snapshot.
// (Fix #4, SAD §5.5.2, SRD FR-S4–S6)
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { start } from 'workflow/api';
import { runWorkflowPipeline } from '../pipeline.js';
import { logger } from '../../lib/logger.js';
import type { WorktreeService } from '../../services/worktree.js';
import type { BranchNamer } from '../../services/branch-namer.js';
import { resolveSandboxResources } from '../../lib/sandbox-resources.js';

// ── Types ────────────────────────────────────────────────────────────

export interface LaunchChildrenInput {
  parentRunId: string;
  selectedProposalIds: string[];
  projectId: string;
  agentDefinitionId: string;
  credentialSetId: string | null;
  ghAccount: string | null;
}

export interface LaunchChildrenOutput {
  groupId: string;
  childRunIds: string[];
}

export interface LaunchChildrenDeps {
  worktreeService: WorktreeService;
  branchNamer: BranchNamer;
}

function resolveGlobalDeps(): LaunchChildrenDeps {
  const deps = (globalThis as any).__vibe_pipeline_deps__;
  if (!deps) throw new Error('Pipeline deps not initialized');
  return deps;
}

// ── Step implementation ──────────────────────────────────────────────

export async function launchChildren(
  input: LaunchChildrenInput,
): Promise<LaunchChildrenOutput> {
  const { parentRunId, selectedProposalIds, projectId, agentDefinitionId, credentialSetId, ghAccount } = input;
  const log = logger.child({ parentRunId });
  const db = getDb();
  const deps = resolveGlobalDeps();

  // ── Idempotency: check if parallel group already exists ───────────
  // Fix #3: On replay, check which children were already created and
  // only launch the missing ones (not all-or-nothing).
  const existingGroup = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.sourceWorkflowRunId, parentRunId))
    .get();

  if (existingGroup) {
    // Group exists — check if ALL expected children were launched
    const children = db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.parallelGroupId, existingGroup.id))
      .all();

    const existingChildProposals = db
      .select({
        id: schema.proposals.id,
        launchedWorkflowRunId: schema.proposals.launchedWorkflowRunId,
      })
      .from(schema.proposals)
      .where(eq(schema.proposals.parallelGroupId, existingGroup.id))
      .all();

    const launchedProposalIds = new Set(
      existingChildProposals
        .filter((p) => p.launchedWorkflowRunId != null)
        .map((p) => p.id),
    );

    const allLaunched = selectedProposalIds.every((id) => launchedProposalIds.has(id));

    if (allLaunched) {
      log.info({ groupId: existingGroup.id }, 'All children already launched');
      return {
        groupId: existingGroup.id,
        childRunIds: children.map((c) => c.id),
      };
    }

    // Partial creation — launch missing children
    log.info('Partial children created, resuming launch for missing proposals');
    return launchMissingChildren(
      db,
      existingGroup.id,
      parentRunId,
      selectedProposalIds,
      launchedProposalIds,
      projectId,
      agentDefinitionId,
      credentialSetId,
      ghAccount,
      deps,
      log,
    );
  }

  // ── Snapshot parent worktree state (SAD §5.5.2) ───────────────────
  const parentRun = db
    .select({
      worktreePath: schema.workflowRuns.worktreePath,
      branch: schema.workflowRuns.branch,
      projectId: schema.workflowRuns.projectId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, parentRunId))
    .get();

  if (!parentRun?.worktreePath) {
    throw new Error(`Parent run ${parentRunId} has no worktree`);
  }

  const project = db
    .select({ localPath: schema.projects.localPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, parentRun.projectId))
    .get();

  if (!project) {
    throw new Error(`Project not found for parent run ${parentRunId}`);
  }

  // Commit any uncommitted changes and get snapshot commit
  const commitResult = await deps.worktreeService.commitAll(
    project.localPath,
    parentRun.worktreePath,
    'Snapshot before split',
  );

  // Get HEAD commit as the snapshot point for children
  const snapshotCommit = commitResult.sha ?? await getHeadCommit(parentRun.worktreePath);

  // ── Create parallel group ─────────────────────────────────────────
  const groupId = crypto.randomUUID();
  db.insert(schema.parallelGroups)
    .values({
      id: groupId,
      sourceWorkflowRunId: parentRunId,
      status: 'running',
      metadata: JSON.stringify({ snapshotCommit }),
    })
    .run();

  // ── Launch children ───────────────────────────────────────────────
  return launchMissingChildren(
    db,
    groupId,
    parentRunId,
    selectedProposalIds,
    new Set(), // no existing children
    projectId,
    agentDefinitionId,
    credentialSetId,
    ghAccount,
    deps,
    log,
    snapshotCommit,
    parentRun.branch,
  );
}

// ── Internal: create child runs for unlaunched proposals ─────────────

async function launchMissingChildren(
  db: ReturnType<typeof getDb>,
  groupId: string,
  parentRunId: string,
  selectedProposalIds: string[],
  alreadyLaunchedProposalIds: Set<string>,
  projectId: string,
  agentDefinitionId: string,
  credentialSetId: string | null,
  ghAccount: string | null,
  deps: LaunchChildrenDeps,
  log: any,
  snapshotCommit?: string,
  parentBranch?: string | null,
): Promise<LaunchChildrenOutput> {
  // Resolve snapshot commit if not provided (replay case)
  if (!snapshotCommit) {
    const parentRun = db
      .select({
        worktreePath: schema.workflowRuns.worktreePath,
        branch: schema.workflowRuns.branch,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, parentRunId))
      .get();

    snapshotCommit = await getHeadCommit(parentRun!.worktreePath!);
    parentBranch = parentRun!.branch;
  }

  // Always load parent's sandbox VM resource overrides AND the project defaults
  // so children inherit the parent's *resolved* values. Snapshotting the
  // resolved values means a project-default change between parent creation
  // and child creation cannot drift VM sizing across siblings.
  const parentSandboxResources = db
    .select({
      sandboxMemory: schema.workflowRuns.sandboxMemory,
      sandboxCpus: schema.workflowRuns.sandboxCpus,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, parentRunId))
    .get();
  const projectSandboxDefaults = db
    .select({
      sandboxMemory: schema.projects.sandboxMemory,
      sandboxCpus: schema.projects.sandboxCpus,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  const resolvedParent = resolveSandboxResources(
    {
      sandboxMemory: projectSandboxDefaults?.sandboxMemory ?? null,
      sandboxCpus: projectSandboxDefaults?.sandboxCpus ?? null,
    },
    {
      sandboxMemory: parentSandboxResources?.sandboxMemory ?? null,
      sandboxCpus: parentSandboxResources?.sandboxCpus ?? null,
    },
  );
  // Re-encode resolved values into row-sentinel form for child rows:
  //   undefined → "" / -1 (explicit "use sbx default", overrides any future
  //   project-default change)
  //   value     → value
  const childSandboxMemoryRow: string | null =
    resolvedParent.memory === undefined ? '' : resolvedParent.memory;
  const childSandboxCpusRow: number | null =
    resolvedParent.cpus === undefined ? -1 : resolvedParent.cpus;

  // Load selected proposals in sort order
  const selectedProposals = selectedProposalIds.length > 0
    ? db
        .select()
        .from(schema.proposals)
        .where(inArray(schema.proposals.id, selectedProposalIds))
        .all()
        .sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  // Find a default workflow template for child runs
  const defaultTemplate = db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.name, 'Quick Run'))
    .get();

  const childRunIds: string[] = [];

  // Collect already-created child IDs
  const existingChildren = db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, groupId))
    .all();
  childRunIds.push(...existingChildren.map((c) => c.id));

  for (const proposal of selectedProposals) {
    if (alreadyLaunchedProposalIds.has(proposal.id)) {
      continue; // Already launched in a prior attempt
    }

    const templateId = proposal.workflowTemplateOverride ?? defaultTemplate?.id;
    if (!templateId) {
      throw new Error('No workflow template available for child run');
    }

    // Generate branch name from proposal title (SAD §5.5.2)
    const existingBranches = await deps.worktreeService.listBranches(
      db.select({ localPath: schema.projects.localPath })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .get()!.localPath,
    );

    const childBranch = await deps.branchNamer.generate(
      proposal.title,
      existingBranches,
      { prefix: `vibe-harness/split-${proposal.id.slice(0, 8)}` },
    );

    // Fix #4: Do NOT create worktree here. Store parentWorktreeCommit
    // so sessionManager.create() can branch from it when provisioning.
    const childRunId = crypto.randomUUID();

    db.insert(schema.workflowRuns)
      .values({
        id: childRunId,
        workflowTemplateId: templateId,
        projectId,
        agentDefinitionId,
        parentRunId,
        parallelGroupId: groupId,
        description: proposal.description,
        title: proposal.title,
        status: 'pending',
        branch: childBranch,
        worktreePath: null, // Created by sessionManager.create()
        credentialSetId,
        ghAccount,
        baseBranch: parentBranch ?? null,
        targetBranch: parentBranch ?? null,
        parentWorktreeCommit: snapshotCommit ?? null,
        // Inherit parent's *resolved* sandbox VM resources (snapshot at split
        // time) so child siblings cannot drift if the project default changes.
        sandboxMemory: childSandboxMemoryRow,
        sandboxCpus: childSandboxCpusRow,
      })
      .run();

    // Update proposal status
    db.update(schema.proposals)
      .set({
        status: 'launched',
        launchedWorkflowRunId: childRunId,
        parallelGroupId: groupId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.proposals.id, proposal.id))
      .run();

    childRunIds.push(childRunId);

    // Fire-and-forget: start child pipeline (SAD §5.2)
    await start(runWorkflowPipeline, [{ runId: childRunId }]);

    log.info({ childRunId, proposal: proposal.title }, 'Child workflow launched');
  }

  return { groupId, childRunIds };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getHeadCommit(worktreePath: string): Promise<string> {
  const { execSync } = await import('node:child_process');
  const result = execSync('git rev-parse HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
  return result.trim();
}
