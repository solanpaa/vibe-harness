import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb, schema } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const row = db
    .select()
    .from(schema.lastRunConfig)
    .where(eq(schema.lastRunConfig.id, 1))
    .get();
  return NextResponse.json(row ?? null);
}

export async function PUT(request: Request) {
  const db = getDb();
  const body = await request.json();

  const existing = db
    .select()
    .from(schema.lastRunConfig)
    .where(eq(schema.lastRunConfig.id, 1))
    .get();

  const values = {
    id: 1,
    projectId: body.projectId ?? null,
    agentDefinitionId: body.agentDefinitionId ?? null,
    credentialSetId: body.credentialSetId ?? null,
    model: body.model ?? null,
    useWorktree: body.useWorktree != null ? (body.useWorktree ? 1 : 0) : 1,
    workflowTemplateId: body.workflowTemplateId ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(schema.lastRunConfig)
      .set(values)
      .where(eq(schema.lastRunConfig.id, 1))
      .run();
  } else {
    db.insert(schema.lastRunConfig).values(values).run();
  }

  return NextResponse.json({ ok: true });
}
