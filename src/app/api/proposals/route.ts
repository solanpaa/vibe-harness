import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  createProposal,
  listProposals,
} from "@/lib/services/proposal-service";

/**
 * GET /api/proposals?taskId=X — list proposals for a task
 * POST /api/proposals — create a new proposal
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");

  if (!taskId) {
    return NextResponse.json(
      { error: "taskId query parameter is required" },
      { status: 400 }
    );
  }

  const proposals = await listProposals(taskId);
  return NextResponse.json(proposals);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { taskId, title, description, affectedFiles, dependsOn } = body;

  if (!taskId || !title || !description) {
    return NextResponse.json(
      { error: "taskId, title, and description are required" },
      { status: 400 }
    );
  }

  const proposal = await createProposal({
    taskId,
    title,
    description,
    affectedFiles,
    dependsOn,
  });

  return NextResponse.json(proposal, { status: 201 });
}
