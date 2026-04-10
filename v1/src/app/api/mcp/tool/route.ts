import { NextRequest, NextResponse } from "next/server";
import {
  createProposal,
  listProposals,
  deleteProposal,
  getPlan,
  getProjectTree,
} from "@/lib/services/proposal-service";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * MCP tool execution endpoint.
 * Called by the stdio MCP bridge inside Docker sandboxes via curl.
 * Dispatches tool calls to the appropriate service functions.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tool, arguments: args, taskId } = body;

    // taskId can come from body or X-Task-Id header
    const resolvedTaskId =
      taskId || request.headers.get("x-task-id") || "";

    if (!resolvedTaskId) {
      return NextResponse.json(
        {
          content: [
            { type: "text", text: "Error: No taskId provided" },
          ],
          isError: true,
        },
        { status: 400 }
      );
    }

    // Validate that the taskId references an existing task
    const db = await getDb();
    const task = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, resolvedTaskId))
      .get();

    if (!task) {
      return NextResponse.json(
        {
          content: [
            { type: "text", text: "Error: Task not found" },
          ],
          isError: true,
        },
        { status: 404 }
      );
    }

    switch (tool) {
      case "propose_task": {
        const proposal = await createProposal({
          taskId: resolvedTaskId,
          title: args.title,
          description: args.description,
          affectedFiles: args.affectedFiles,
          dependsOn: args.dependsOn,
        });
        return NextResponse.json({
          content: [
            {
              type: "text",
              text: `Created proposal "${proposal.title}" (ID: ${proposal.id})`,
            },
          ],
        });
      }

      case "get_plan": {
        const plan = await getPlan(resolvedTaskId);
        if (!plan) {
          return NextResponse.json({
            content: [
              {
                type: "text",
                text: "No plan found from previous stages. This task may not be part of a workflow, or the plan stage hasn't completed yet.",
              },
            ],
          });
        }
        return NextResponse.json({
          content: [{ type: "text", text: plan }],
        });
      }

      case "list_proposals": {
        const proposals = await listProposals(resolvedTaskId);
        if (proposals.length === 0) {
          return NextResponse.json({
            content: [
              {
                type: "text",
                text: "No proposals created yet. Use propose_task to create sub-tasks.",
              },
            ],
          });
        }
        const summary = proposals
          .map(
            (p, i) =>
              `${i + 1}. [${p.status}] ${p.title} (ID: ${p.id})\n` +
              `   ${p.description.slice(0, 120)}${p.description.length > 120 ? "..." : ""}\n` +
              `   Files: ${p.affectedFiles.length > 0 ? p.affectedFiles.join(", ") : "not specified"}\n` +
              `   Depends on: ${p.dependsOn.length > 0 ? p.dependsOn.join(", ") : "none"}`
          )
          .join("\n\n");
        return NextResponse.json({
          content: [
            {
              type: "text",
              text: `${proposals.length} proposal(s):\n\n${summary}`,
            },
          ],
        });
      }

      case "delete_proposal": {
        const deleted = await deleteProposal(args.proposalId);
        return NextResponse.json({
          content: [
            {
              type: "text",
              text: deleted
                ? `Deleted proposal ${args.proposalId}`
                : `Proposal ${args.proposalId} not found`,
            },
          ],
        });
      }

      case "get_project_tree": {
        const tree = await getProjectTree(resolvedTaskId, {
          maxDepth: args?.maxDepth,
          directory: args?.directory,
        });
        if (!tree) {
          return NextResponse.json({
            content: [
              { type: "text", text: "Could not retrieve project tree." },
            ],
            isError: true,
          });
        }
        return NextResponse.json({
          content: [{ type: "text", text: tree }],
        });
      }

      default:
        return NextResponse.json(
          {
            content: [
              { type: "text", text: `Unknown tool: ${tool}` },
            ],
            isError: true,
          },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("[MCP Tool] Error:", error);
    return NextResponse.json(
      {
        content: [
          {
            type: "text",
            text: "Internal error processing tool call",
          },
        ],
        isError: true,
      },
      { status: 500 }
    );
  }
}
