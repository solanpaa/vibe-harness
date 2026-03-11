import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const db = getDb();
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (projectId) {
    const subs = db
      .select()
      .from(schema.subprojects)
      .where(eq(schema.subprojects.projectId, projectId))
      .all();
    return NextResponse.json(subs);
  }
  const all = db.select().from(schema.subprojects).all();
  return NextResponse.json(all);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();
  const now = new Date().toISOString();
  const subproject = {
    id: uuid(),
    projectId: body.projectId,
    name: body.name,
    description: body.description || null,
    pathFilter: body.pathFilter || null,
    createdAt: now,
  };
  db.insert(schema.subprojects).values(subproject).run();
  return NextResponse.json(subproject, { status: 201 });
}
