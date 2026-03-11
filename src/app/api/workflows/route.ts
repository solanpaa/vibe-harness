import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const allWorkflows = db.select().from(schema.workflowTemplates).all();
  return NextResponse.json(allWorkflows);
}
