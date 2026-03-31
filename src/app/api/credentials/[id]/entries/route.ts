import { NextRequest, NextResponse } from "next/server";
import {
  addCredentialEntry,
  getCredentialEntries,
} from "@/lib/services/credential-vault";
import type { CredentialEntryType } from "@/types/domain";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entries = await getCredentialEntries(id);
  return NextResponse.json(entries);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const entry = await addCredentialEntry({
    credentialSetId: id,
    key: body.key,
    value: body.value,
    type: body.type as CredentialEntryType,
    mountPath: body.mountPath || null,
  });
  return NextResponse.json(entry, { status: 201 });
}
