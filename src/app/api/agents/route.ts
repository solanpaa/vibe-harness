import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const agents = db.select().from(schema.agentDefinitions).all();
  return NextResponse.json(agents);
}
