import { getDb, schema } from "@/lib/db";
import { launchSandbox, stopSandbox, getSandbox, sendInput } from "./sandbox";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

export interface StartSessionOptions {
  sessionId: string;
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt: string;
}

/** Start a session by launching its sandbox */
export function startSession(options: StartSessionOptions) {
  const db = getDb();
  const sandbox = launchSandbox(options.sessionId, {
    projectDir: options.projectDir,
    agentCommand: options.agentCommand,
    credentialSetId: options.credentialSetId,
    dockerImage: options.dockerImage,
    prompt: options.prompt,
  });

  // Update session status
  db.update(schema.sessions)
    .set({
      status: "running",
      sandboxId: options.sessionId,
    })
    .where(eq(schema.sessions.id, options.sessionId))
    .run();

  // Listen for completion
  sandbox.events.on("close", (code: number) => {
    const status = code === 0 ? "completed" : "failed";
    const output = sandbox.output.join("");
    db.update(schema.sessions)
      .set({
        status,
        output,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, options.sessionId))
      .run();
  });

  return sandbox;
}

/** Stop a running session */
export function stopSession(sessionId: string) {
  const db = getDb();
  const stopped = stopSandbox(sessionId);
  if (stopped) {
    db.update(schema.sessions)
      .set({
        status: "failed",
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  }
  return stopped;
}

/** Send input to a running session */
export function sendSessionInput(sessionId: string, input: string) {
  return sendInput(sessionId, input);
}

/** Get sandbox for streaming */
export function getSessionSandbox(sessionId: string) {
  return getSandbox(sessionId);
}
