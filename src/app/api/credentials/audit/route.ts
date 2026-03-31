import { NextRequest, NextResponse } from "next/server";
import { getAuditLog } from "@/lib/services/credential-vault";

export async function GET(request: NextRequest) {
  const credentialSetId = request.nextUrl.searchParams.get("credentialSetId");
  const logs = getAuditLog(credentialSetId || undefined);
  return NextResponse.json(logs);
}
