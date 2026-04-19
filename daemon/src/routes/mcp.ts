// ---------------------------------------------------------------------------
// MCP Tool Endpoint (ported from v1)
//
// Called by the MCP bridge (vibe-mcp-bridge.js) running inside Docker
// sandboxes. Dispatches tool calls to the appropriate service functions.
// The bridge uses curl to call back to this endpoint over the sandbox proxy.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { createProposalService } from '../services/proposal-service.js';

const mcp = new Hono();
const log = logger.child({ route: 'mcp' });

mcp.post('/api/mcp/tool', async (c) => {
  try {
    const body = await c.req.json();
    const { tool, arguments: args, runId } = body;

    if (!runId) {
      return c.json({
        content: [{ type: 'text', text: 'Error: No runId provided' }],
        isError: true,
      }, 400);
    }

    const db = getDb();

    // Validate run exists
    const run = db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();

    if (!run) {
      return c.json({
        content: [{ type: 'text', text: 'Error: Run not found' }],
        isError: true,
      }, 404);
    }

    switch (tool) {
      case 'propose_task': {
        const proposalService = createProposalService({ logger: log, db });
        // Derive stage name from the run's current stage
        const stageName = run.currentStage;
        if (!stageName) {
          return c.json({
            content: [{ type: 'text', text: 'Error: Run has no active stage' }],
            isError: true,
          }, 400);
        }

        const proposal = proposalService.createProposal({
          workflowRunId: runId,
          stageName,
          title: args.title,
          description: args.description,
          affectedFiles: args.affectedFiles,
          dependsOn: args.dependsOn,
        });

        return c.json({
          content: [{
            type: 'text',
            text: `Created proposal "${proposal.title}" (ID: ${proposal.id})`,
          }],
        });
      }

      case 'get_plan': {
        // Find the most recent review with planMarkdown for this run
        const review = db
          .select()
          .from(schema.reviews)
          .where(eq(schema.reviews.workflowRunId, runId))
          .orderBy(desc(schema.reviews.createdAt))
          .limit(1)
          .get();

        if (!review) {
          return c.json({
            content: [{
              type: 'text',
              text: 'No plan found from previous stages.',
            }],
          });
        }

        const plan = review.planMarkdown || review.aiSummary || null;
        return c.json({
          content: [{
            type: 'text',
            text: plan || 'No plan content available.',
          }],
        });
      }

      case 'list_proposals': {
        const proposals = db
          .select()
          .from(schema.proposals)
          .where(eq(schema.proposals.workflowRunId, runId))
          .all();

        if (proposals.length === 0) {
          return c.json({
            content: [{
              type: 'text',
              text: 'No proposals created yet. Use propose_task to create sub-tasks.',
            }],
          });
        }

        const summary = proposals
          .map((p, i) =>
            `${i + 1}. [${p.status}] ${p.title} (ID: ${p.id})\n` +
            `   ${p.description.slice(0, 120)}${p.description.length > 120 ? '...' : ''}\n` +
            `   Files: ${p.affectedFiles ? JSON.parse(p.affectedFiles).join(', ') : 'not specified'}`,
          )
          .join('\n\n');

        return c.json({
          content: [{
            type: 'text',
            text: `${proposals.length} proposal(s):\n\n${summary}`,
          }],
        });
      }

      case 'delete_proposal': {
        const proposalService = createProposalService({ logger: log, db });
        try {
          proposalService.deleteProposal(args.proposalId);
          return c.json({
            content: [{ type: 'text', text: `Deleted proposal ${args.proposalId}` }],
          });
        } catch {
          return c.json({
            content: [{ type: 'text', text: `Proposal ${args.proposalId} not found` }],
          });
        }
      }

      case 'get_project_tree': {
        const project = db
          .select({ localPath: schema.projects.localPath })
          .from(schema.projects)
          .where(eq(schema.projects.id, run.projectId))
          .get();

        if (!project?.localPath) {
          return c.json({
            content: [{ type: 'text', text: 'Could not find project path.' }],
            isError: true,
          });
        }

        // Use worktree path if available, otherwise project root
        const workDir = run.worktreePath && existsSync(run.worktreePath)
          ? run.worktreePath
          : project.localPath;

        const targetDir = args?.directory
          ? join(workDir, args.directory)
          : workDir;

        try {
          const files = execSync(
            'git ls-files --cached --others --exclude-standard',
            { cwd: targetDir, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 },
          ).trim();

          let fileList = files.split('\n').filter(Boolean);
          if (args?.maxDepth) {
            fileList = fileList.filter(
              (f: string) => f.split('/').length <= args.maxDepth,
            );
          }

          return c.json({
            content: [{ type: 'text', text: fileList.sort().join('\n') }],
          });
        } catch (e) {
          return c.json({
            content: [{ type: 'text', text: `Error listing files: ${(e as Error).message}` }],
            isError: true,
          });
        }
      }

      default:
        return c.json({
          content: [{ type: 'text', text: `Unknown tool: ${tool}` }],
          isError: true,
        }, 400);
    }
  } catch (error) {
    log.error({ err: error }, 'MCP tool error');
    return c.json({
      content: [{ type: 'text', text: 'Internal error processing tool call' }],
      isError: true,
    }, 500);
  }
});

export default mcp;
