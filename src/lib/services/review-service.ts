import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { parseUnifiedDiff, diffSummary } from "./diff-service";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Resolve the working directory for a session — worktree if it exists,
 * otherwise the project root.
 */
function resolveSessionWorkDir(projectDir: string, sessionId: string): string {
  const shortId = sessionId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);
  if (fs.existsSync(worktreePath)) {
    return worktreePath;
  }
  return projectDir;
}

/**
 * Create a review after an agent session completes.
 * Captures git diff from the worktree (includes uncommitted changes),
 * generates a summary, and stores as a Review record.
 */
export async function createReviewForSession(sessionId: string): Promise<string | null> {
  const db = getDb();

  const session = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();

  if (!session) return null;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, session.projectId))
    .get();

  if (!project) return null;

  const workDir = resolveSessionWorkDir(project.localPath, sessionId);

  // Capture ALL changes: staged, unstaged, and untracked new files
  let diffText = "";
  try {
    // First, add untracked files to the index so they show up in the diff
    execSync("git add -N .", { cwd: workDir, stdio: "pipe" });
    // Then diff everything against HEAD
    diffText = execSync("git diff HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    try {
      // Fallback: just diff working tree
      diffText = execSync("git diff", {
        cwd: workDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      diffText = "<!-- No git diff available -->";
    }
  }

  // Parse and generate summary
  const files = parseUnifiedDiff(diffText);
  const summary = diffSummary(files);

  // Build AI summary (for now, use a structured summary; later, call an agent)
  const aiSummary = generateStructuredSummary(session, files, summary);

  // Count existing reviews for this session to determine round
  const existingReviews = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.sessionId, sessionId))
    .all();
  const round = existingReviews.length + 1;

  // Create review record
  const reviewId = uuid();
  const now = new Date().toISOString();
  db.insert(schema.reviews)
    .values({
      id: reviewId,
      workflowRunId: session.workflowRunId,
      sessionId,
      round,
      status: "pending_review",
      aiSummary,
      diffSnapshot: diffText,
      createdAt: now,
    })
    .run();

  return reviewId;
}

function generateStructuredSummary(
  session: { prompt: string; output: string | null },
  files: ReturnType<typeof parseUnifiedDiff>,
  changeSummary: string
): string {
  const filesByStatus = {
    added: files.filter((f) => f.status === "added"),
    modified: files.filter((f) => f.status === "modified"),
    deleted: files.filter((f) => f.status === "deleted"),
    renamed: files.filter((f) => f.status === "renamed"),
  };

  let md = `## Session Summary\n\n`;
  md += `**Prompt:** ${session.prompt}\n\n`;
  md += `### Changes Overview\n\n`;
  md += `${changeSummary}\n\n`;

  if (filesByStatus.added.length > 0) {
    md += `### New Files\n`;
    for (const f of filesByStatus.added) {
      md += `- \`${f.path}\` (+${f.additions} lines)\n`;
    }
    md += `\n`;
  }

  if (filesByStatus.modified.length > 0) {
    md += `### Modified Files\n`;
    for (const f of filesByStatus.modified) {
      md += `- \`${f.path}\` (+${f.additions} -${f.deletions})\n`;
    }
    md += `\n`;
  }

  if (filesByStatus.deleted.length > 0) {
    md += `### Deleted Files\n`;
    for (const f of filesByStatus.deleted) {
      md += `- \`${f.path}\`\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Bundle review comments into a structured prompt for the next agent round.
 */
export function bundleCommentsAsPrompt(reviewId: string): string {
  const db = getDb();

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) return "";

  const comments = db
    .select()
    .from(schema.reviewComments)
    .where(eq(schema.reviewComments.reviewId, reviewId))
    .all();

  if (comments.length === 0) return "";

  // Group comments by file
  const byFile = new Map<string, typeof comments>();
  for (const c of comments) {
    const existing = byFile.get(c.filePath) || [];
    existing.push(c);
    byFile.set(c.filePath, existing);
  }

  let prompt = `The following review comments were left on your changes. Please address each one:\n\n`;

  for (const [filePath, fileComments] of byFile) {
    prompt += `## ${filePath}\n`;
    for (const c of fileComments) {
      const lineRef = c.lineNumber ? `Line ${c.lineNumber}: ` : "";
      prompt += `- ${lineRef}${JSON.stringify(c.body)}\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}
