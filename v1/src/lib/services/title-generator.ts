import { execFile } from "node:child_process";

// ── Cached copilot binary path ──────────────────────────────────────────────

let copilotPath: string | null | undefined; // undefined = not yet resolved

function getCopilotPath(): Promise<string | null> {
  if (copilotPath !== undefined) return Promise.resolve(copilotPath);

  return new Promise((resolve) => {
    execFile("which", ["copilot"], { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        console.warn("[title-generator] copilot CLI not found in PATH — titles will use prompt extraction");
        copilotPath = null;
        resolve(null);
        return;
      }
      copilotPath = stdout.trim();
      resolve(copilotPath);
    });
  });
}

// ── Fallback: extract title from prompt text ────────────────────────────────

function extractTitleFromPrompt(prompt: string): string {
  // Strip markdown headers, stage instructions, and common prefixes
  const cleaned = prompt
    .replace(/^##?\s+(Task|Current Stage|Context from Previous Stage|Your Assignment)[^\n]*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .trim();

  // Take first meaningful sentence/phrase
  const firstLine = cleaned.split("\n").map((l) => l.trim()).find((l) => l.length > 5) ?? cleaned;
  // Truncate to ~6 words
  const words = firstLine.split(/\s+/).slice(0, 6);
  let title = words.join(" ");

  // Clean up trailing punctuation
  title = title.replace(/[.:,;!?]+$/, "").trim();

  if (title.length > 80) title = title.slice(0, 77) + "…";
  return title || "Untitled task";
}

// ── Main function ───────────────────────────────────────────────────────────

/**
 * Generate a short (3–6 word) title from a task prompt.
 * Tries the Copilot CLI first, falls back to prompt extraction.
 * Always returns a non-null title.
 */
export async function generateTitle(prompt: string): Promise<string> {
  // Try CLI-based generation
  const cliTitle = await generateTitleViaCli(prompt);
  if (cliTitle) return cliTitle;

  // Fallback: extract from prompt
  return extractTitleFromPrompt(prompt);
}

function generateTitleViaCli(prompt: string): Promise<string | null> {
  return new Promise(async (resolve) => {
    const binPath = await getCopilotPath();
    if (!binPath) {
      resolve(null);
      return;
    }

    const systemPrompt =
      "Generate a very short title (3-6 words, no quotes, no punctuation at the end) that summarizes this task:";
    const fullPrompt = `${systemPrompt}\n\n${prompt.slice(0, 500)}`;

    const child = execFile(
      binPath,
      [
        "-p",
        fullPrompt,
        "--model",
        "gpt-4.1",
        "--output-format",
        "text",
        "--yolo",
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const title = stdout
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith("Total usage") && !l.startsWith("API time") && !l.startsWith("Breakdown")) ?? "";
        if (title.length > 0 && title.length < 100) {
          resolve(title);
        } else {
          resolve(null);
        }
      },
    );

    child.stdin?.end();
  });
}
