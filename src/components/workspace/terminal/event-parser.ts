// ---- Local event types (client-side, no server imports) -------------------

export type TerminalEvent =
  | { kind: "message"; content: string }
  | { kind: "user_message"; content: string }
  | { kind: "session_info"; text: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_start"; name: string; detail: string }
  | { kind: "result"; exitCode: number; premiumRequests?: number; durationMs?: number }
  | { kind: "raw"; text: string };

// ---- Helpers --------------------------------------------------------------

/** Strip OSC sequences (terminal title, etc.) for legacy raw output */
export function stripOsc(line: string): string {
  return line.replace(/\]0;[^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

/** Shorten long file paths — keep last 2-3 segments */
export function shortenPath(p: string): string {
  // Strip common worktree prefixes
  const worktreeMatch = p.match(/\.vibe-harness-worktrees\/[^/]+\/(.+)/);
  if (worktreeMatch) return worktreeMatch[1];
  // Strip /Users/.../personal/project/ style prefixes
  const segments = p.split("/");
  if (segments.length > 4) {
    return "…/" + segments.slice(-3).join("/");
  }
  return p;
}

/** Extract a short detail string for a tool_start event */
export function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
    case "shell": {
      const cmd = (args.command as string) ?? (args.cmd as string) ?? "";
      const desc = (args.description as string) ?? "";
      // Prefer the description if available (human-readable summary)
      if (desc) return desc;
      // Shorten worktree and common absolute paths in bash commands
      return cmd
        .replace(/\/\S*\.vibe-harness-worktrees\/[^/\s]+\//g, "")
        .replace(/\/Users\/[^/]+\/[^/]+\/[^/]+\//g, "…/")
        .replace(/\/home\/[^/]+\/[^/]+\//g, "…/");
    }
    case "edit":
    case "view":
    case "create":
      return shortenPath((args.path as string) ?? (args.file_path as string) ?? "");
    case "grep":
      return (args.pattern as string) ?? "";
    case "glob":
      return (args.pattern as string) ?? "";
    case "sql":
      return (args.description as string) ?? "";
    case "task":
      return (args.description as string) ?? "";
    default: {
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
      return "";
    }
  }
}

/**
 * Map a parsed JSONL event from the SSE stream to a TerminalEvent, or null
 * if the event should be skipped.
 */
export function mapJsonlEvent(event: Record<string, unknown>): TerminalEvent | null {
  const type = event.type as string;
  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case "assistant.message": {
      const toolRequests = data.toolRequests as unknown[] | undefined;
      if (toolRequests && toolRequests.length > 0) return null;
      const content = (data.content as string) ?? "";
      if (!content) return null;
      return { kind: "message", content };
    }
    case "assistant.reasoning": {
      const content = (data.content as string) ?? "";
      if (!content) return null;
      return { kind: "reasoning", content };
    }
    case "tool.execution_start": {
      if (data.parentToolCallId) return null;
      const name = (data.toolName as string) ?? (data.name as string) ?? "tool";
      if (name === "report_intent") return null;
      const args = (data.arguments as Record<string, unknown>) ?? {};
      return { kind: "tool_start", name, detail: toolDetail(name, args) };
    }
    case "result": {
      const exitCode = (event.exitCode as number) ?? 0;
      const usage = event.usage as Record<string, unknown> | undefined;
      return {
        kind: "result",
        exitCode,
        premiumRequests: usage?.premiumRequests as number | undefined,
        durationMs: usage?.sessionDurationMs as number | undefined,
      };
    }
    case "user.message": {
      const content = (data.content as string) ?? "";
      if (!content) return null;
      return { kind: "user_message", content };
    }
    case "session.tools_updated": {
      const model = data.model as string | undefined;
      if (model) return { kind: "session_info", text: `Model: ${model}` };
      return null;
    }
    case "tool.execution_complete":
    case "assistant.message_delta":
    case "assistant.reasoning_delta":
    case "assistant.turn_start":
    case "assistant.turn_end":
    case "session.background_tasks_changed":
      return null;
    default:
      return null;
  }
}

/** Parse a single raw output line into a TerminalEvent (for initialOutput reconstruction) */
export function parseLine(line: string): TerminalEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return mapJsonlEvent(parsed);
    }
  } catch {
    if (trimmed.startsWith("{") || trimmed.startsWith('"type"')) {
      return null;
    }
  }

  if (/^[✓▶⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) return null;
  if (trimmed === "tool" || trimmed.startsWith("Compiling")) return null;

  return { kind: "raw", text: line };
}
