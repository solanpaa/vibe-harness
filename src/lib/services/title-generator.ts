import { CopilotClient, approveAll } from "@github/copilot-sdk";

/**
 * Generate a short (3–6 word) title from a task prompt using GitHub Copilot.
 * Returns null on any failure so callers can fall back to a truncated prompt.
 */
export async function generateTitle(
  prompt: string,
): Promise<string | null> {
  let client: CopilotClient | undefined;
  try {
    client = new CopilotClient();

    const session = await client.createSession({
      model: "gpt-4.1",
      onPermissionRequest: approveAll,
    });

    const response = await session.sendAndWait({
      prompt: `Generate a very short title (3-6 words, no quotes, no punctuation at the end) that summarizes this task:\n\n${prompt.slice(0, 500)}`,
    });

    await session.disconnect();

    const title = response?.data?.content?.trim();
    if (title && title.length > 0 && title.length < 100) {
      return title;
    }
    return null;
  } catch {
    // Copilot SDK not available or failed — gracefully return null
    return null;
  } finally {
    if (client) {
      await client.stop().catch(() => {});
    }
  }
}
