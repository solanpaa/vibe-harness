import { NextRequest, NextResponse } from "next/server";
import { deleteCredentialEntry } from "@/lib/services/credential-vault";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { entryId } = await params;
  deleteCredentialEntry(entryId);
  return NextResponse.json({ ok: true });
}
