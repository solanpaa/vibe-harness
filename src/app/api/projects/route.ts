import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET() {
  const db = getDb();
  const allProjects = db.select().from(schema.projects).all();
  return NextResponse.json(allProjects);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();
  const now = new Date().toISOString();
  const project = {
    id: uuid(),
    name: body.name,
    gitUrl: body.gitUrl || null,
    localPath: body.localPath,
    description: body.description || null,
    defaultCredentialSetId: body.defaultCredentialSetId || null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.projects).values(project).run();
  return NextResponse.json(project, { status: 201 });
}
