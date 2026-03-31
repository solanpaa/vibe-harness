import { NextRequest, NextResponse } from "next/server";
import {
  updateProposal,
  deleteProposal,
} from "@/lib/services/proposal-service";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * PATCH /api/proposals/[id] — update a proposal
 * DELETE /api/proposals/[id] — delete a proposal
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const result = await updateProposal(id, body);
  if (!result) {
    return NextResponse.json(
      { error: "Proposal not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ...result,
    affectedFiles: result.affectedFiles
      ? JSON.parse(result.affectedFiles)
      : [],
    dependsOn: result.dependsOn ? JSON.parse(result.dependsOn) : [],
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deleted = await deleteProposal(id);

  if (!deleted) {
    return NextResponse.json(
      { error: "Proposal not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ deleted: true });
}
