import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { execSync } from "child_process";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const rawBranches = execSync("git branch", {
      cwd: project.localPath,
      encoding: "utf-8",
    });

    const branches = rawBranches
      .split("\n")
      .map((line) => line.replace(/^\*?\s+/, "").trim())
      .filter(Boolean);

    let current = "";
    try {
      current = execSync("git branch --show-current", {
        cwd: project.localPath,
        encoding: "utf-8",
      }).trim();
    } catch {
      // detached HEAD or other edge case — leave current empty
    }

    return NextResponse.json({ branches, current });
  } catch {
    // Not a git repo or no branches yet
    return NextResponse.json({ branches: [], current: "" });
  }
}
