import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import {
  createWorkflowTemplate,
  startWorkflowRun,
  getDefaultWorkflowStages,
} from "@/lib/services/workflow-engine";

export async function GET() {
  const db = await getDb();
  const allWorkflows = await db.select().from(schema.workflowTemplates).all();
  return NextResponse.json(
    allWorkflows.map((w) => ({ ...w, stages: JSON.parse(w.stages) }))
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === "create_template") {
    const template = await createWorkflowTemplate({
      name: body.name,
      description: body.description,
      stages: body.stages || getDefaultWorkflowStages(),
    });
    return NextResponse.json(template, { status: 201 });
  }

  if (body.action === "start_run") {
    const result = await startWorkflowRun({
      workflowTemplateId: body.workflowTemplateId,
      projectId: body.projectId,
      taskDescription: body.taskDescription || body.prompt || "",
      agentDefinitionId: body.agentDefinitionId,
      credentialSetId: body.credentialSetId,
      model: body.model,
      useWorktree: body.useWorktree,
      branch: body.branch,
    });
    return NextResponse.json(result, { status: 201 });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
