import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import fs from "fs";

export async function GET() {
  const db = await getDb();
  const allProjects = await db.select().from(schema.projects).all();
  return NextResponse.json(allProjects);
}

export async function POST(request: NextRequest) {
  const db = await getDb();
  const body = await request.json();

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!body.localPath?.trim()) {
    return NextResponse.json({ error: "Local path is required" }, { status: 400 });
  }
  if (!fs.existsSync(body.localPath)) {
    return NextResponse.json(
      { error: `Directory does not exist: ${body.localPath}` },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const project = {
    id: uuid(),
    name: body.name.trim(),
    gitUrl: body.gitUrl || null,
    localPath: body.localPath.trim(),
    description: body.description || null,
    defaultCredentialSetId: body.defaultCredentialSetId || null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.projects).values(project).run();
  return NextResponse.json(project, { status: 201 });
}
