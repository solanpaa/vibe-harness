import { NextRequest, NextResponse } from "next/server";
import {
  addCredentialEntry,
  getCredentialEntries,
} from "@/lib/services/credential-vault";
import type { CredentialEntryType } from "@/types/domain";

/**
 * Validates mountPath for file credentials.
 * Must start with "/" and contain only safe characters.
 */
function validateMountPath(mountPath: string | null | undefined): boolean {
  if (!mountPath) return true; // mountPath is optional
  if (typeof mountPath !== "string") return false;
  if (!mountPath.startsWith("/")) return false;
  // Allow only alphanumeric, forward slashes, hyphens, underscores, and dots
  return /^\/[a-zA-Z0-9\/_.\-]*$/.test(mountPath);
}

/**
 * Validates docker registry and username for docker_login credentials.
 * Allow alphanumeric, hyphens, underscores, dots, and colons (for port numbers).
 */
function validateDockerIdentifier(identifier: string): boolean {
  if (typeof identifier !== "string" || !identifier) return false;
  return /^[a-zA-Z0-9._:\-]+$/.test(identifier);
}

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
  
  // Validate input based on credential type
  const type = body.type as CredentialEntryType;
  
  // Validate mountPath for file-based credentials
  if (!validateMountPath(body.mountPath)) {
    return NextResponse.json(
      { error: "Invalid mountPath: must start with / and contain only alphanumeric, /, -, _, . characters" },
      { status: 400 }
    );
  }
  
  // Validate docker_login credentials
  if (type === "docker_login") {
    const registry = body.key;
    if (!validateDockerIdentifier(registry)) {
      return NextResponse.json(
        { error: "Invalid registry: must contain only alphanumeric, -, _, ., : characters" },
        { status: 400 }
      );
    }
    
    // Parse and validate username from value (expected to be JSON with username field)
    try {
      const valueObj = typeof body.value === "string" ? JSON.parse(body.value) : body.value;
      const username = valueObj?.username;
      if (!validateDockerIdentifier(username)) {
        return NextResponse.json(
          { error: "Invalid username: must contain only alphanumeric, -, _, ., : characters" },
          { status: 400 }
        );
      }
    } catch (err) {
      return NextResponse.json(
        { error: "Invalid docker_login value: must be valid JSON with username field" },
        { status: 400 }
      );
    }
  }
  
  const entry = await addCredentialEntry({
    credentialSetId: id,
    key: body.key,
    value: body.value,
    type,
    mountPath: body.mountPath || null,
  });
  return NextResponse.json(entry, { status: 201 });
}
