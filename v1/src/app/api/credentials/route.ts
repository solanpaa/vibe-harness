import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";

export async function GET() {
  const db = await getDb();
  const sets = await db.select().from(schema.credentialSets).all();
  return NextResponse.json(sets);
}

export async function POST(request: NextRequest) {
  const db = await getDb();
  const body = await request.json();
  const now = new Date().toISOString();
  const credSet = {
    id: uuid(),
    name: body.name,
    description: body.description || null,
    projectId: body.projectId || null,
    createdAt: now,
  };
  await db.insert(schema.credentialSets).values(credSet).run();
  return NextResponse.json(credSet, { status: 201 });
}
