import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/utils/encryption";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { id, entryId } = await params;
  const db = await getDb();

  const entry = await db
    .select()
    .from(schema.credentialEntries)
    .where(
      and(
        eq(schema.credentialEntries.id, entryId),
        eq(schema.credentialEntries.credentialSetId, id)
      )
    )
    .get();

  if (!entry) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }

  try {
    const decrypted = decrypt(entry.value);

    switch (entry.type) {
      case "env_var": {
        // Basic validation: non-empty
        const valid = decrypted.length > 0;
        return NextResponse.json({
          valid,
          message: valid ? "Value is non-empty" : "Value is empty",
        });
      }

      case "file_mount": {
        // Validate content structure based on common formats
        const checks: string[] = [];
        if (decrypted.length === 0) {
          return NextResponse.json({ valid: false, message: "File content is empty" });
        }
        checks.push(`Content length: ${decrypted.length} bytes`);

        if (decrypted.includes("-----BEGIN") && decrypted.includes("-----END")) {
          checks.push("Detected PEM-encoded key/certificate");
        }
        try {
          JSON.parse(decrypted);
          checks.push("Valid JSON content");
        } catch {
          // Not JSON, that's fine
        }
        if (!entry.mountPath) {
          checks.push("⚠ No mount path specified — file won't be injected into sandbox");
        }

        return NextResponse.json({
          valid: true,
          message: checks.join(". "),
        });
      }

      case "docker_login": {
        // Validate JSON structure
        try {
          const parsed = JSON.parse(decrypted);
          const hasUsername = !!parsed.username;
          const hasPassword = !!parsed.password;
          if (!hasUsername || !hasPassword) {
            return NextResponse.json({
              valid: false,
              message: `Missing ${!hasUsername ? "username" : ""}${!hasUsername && !hasPassword ? " and " : ""}${!hasPassword ? "password" : ""}`,
            });
          }
          return NextResponse.json({
            valid: true,
            message: `Registry: ${entry.key}, Username: ${parsed.username}`,
          });
        } catch {
          return NextResponse.json({
            valid: false,
            message: "Invalid JSON format — expected {username, password}",
          });
        }
      }

      default:
        return NextResponse.json({
          valid: false,
          message: `Unknown credential type: ${entry.type}`,
        });
    }
  } catch (err) {
    return NextResponse.json({
      valid: false,
      message: `Decryption failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
}
