import { getDb, schema } from "@/lib/db";
import { launchSandbox, stopSandbox, getSandbox, sendInput } from "./sandbox";
import { createWorktree, removeWorktree } from "./worktree";
import { eq } from "drizzle-orm";

export interface StartSessionOptions {
  sessionId: string;
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt: string;
  model?: string | null;
  useWorktree?: boolean;
  isContinuation?: boolean;
}

/** Start a session by launching its sandbox, optionally in a git worktree */
export function startSession(options: StartSessionOptions) {
  const db = getDb();
  const useWorktree = options.useWorktree !== false;

  let workDir = options.projectDir;
  let branch = "";
  let isWorktree = false;

  // Create a git worktree for session isolation
  if (useWorktree) {
    try {
      const wt = createWorktree(options.projectDir, options.sessionId);
      workDir = wt.worktreePath;
      branch = wt.branch;
      isWorktree = wt.isWorktree;
    } catch (e) {
      console.error("Failed to create worktree, using project dir directly:", e);
    }
  }

  const shortId = options.sessionId.slice(0, 8);
  const sandbox = launchSandbox(options.sessionId, {
    projectDir: workDir,
    agentCommand: options.agentCommand,
    credentialSetId: options.credentialSetId,
    dockerImage: options.dockerImage,
    prompt: options.prompt,
    model: options.model,
    isContinuation: options.isContinuation,
    sandboxName: `vibe-${shortId}`,
  });

  // Update session status with worktree info
  db.update(schema.sessions)
    .set({
      status: "running",
      sandboxId: `vibe-${shortId}`,
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
