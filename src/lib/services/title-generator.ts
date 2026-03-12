import { execFile } from "node:child_process";

/**
 * Generate a short (3–6 word) title from a task prompt using the Copilot CLI.
 * Uses the CLI directly in non-interactive mode for reliability.
 * Returns null on any failure so callers can fall back gracefully.
 */
export function generateTitle(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const systemPrompt =
      "Generate a very short title (3-6 words, no quotes, no punctuation at the end) that summarizes this task:";
    const fullPrompt = `${systemPrompt}\n\n${prompt.slice(0, 500)}`;

    const child = execFile(
      "copilot",
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
          console.warn("[title-generator] CLI failed:", err.message);
          resolve(null);
          return;
        }
        const title = stdout.trim();
        if (title && title.length > 0 && title.length < 100) {
          resolve(title);
        } else {
          console.warn("[title-generator] Empty or oversized title:", title);
          resolve(null);
        }
      },
    );

    child.stdin?.end();
  });
}
