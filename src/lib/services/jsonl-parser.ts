// ---------------------------------------------------------------------------
// Copilot CLI JSONL Parser
// Parses `--output-format json` output into typed events and accumulates
// a structured summary (ParsedAgentOutput).
// ---------------------------------------------------------------------------

// ---- Event data interfaces ------------------------------------------------

export interface ToolRequest {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  type: string;
}

export interface SessionToolsUpdatedData {
  model: string;
}

export interface UserMessageData {
  content: string;
  transformedContent?: string;
  source: string;
  attachments?: unknown[];
  interactionId?: string;
}

export interface AssistantTurnStartData {
  turnId: string;
  interactionId?: string;
}

export interface AssistantTurnEndData {
  turnId: string;
}

export interface AssistantMessageData {
  messageId: string;
  content: string;
  toolRequests?: ToolRequest[];
}

export interface AssistantMessageDeltaData {
  messageId: string;
  deltaContent: string;
}

export interface AssistantReasoningData {
  messageId: string;
  content: string;
}

export interface AssistantReasoningDeltaData {
  messageId: string;
  deltaContent: string;
}

export interface ToolExecutionStartData {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionCompleteData {
  toolCallId: string;
  name: string;
  result: string;
}

export interface ResultUsage {
  premiumRequests: number;
  totalApiDurationMs: number;
  sessionDurationMs: number;
}

export interface ResultCodeChanges {
  linesAdded: number;
  linesRemoved: number;
  filesModified: string[];
}

// ---- Discriminated union of all events ------------------------------------

interface BaseEvent {
  id?: string;
  timestamp?: string;
  parentId?: string;
  ephemeral?: boolean;
}

export interface SessionToolsUpdatedEvent extends BaseEvent {
  type: "session.tools_updated";
  data: SessionToolsUpdatedData;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  data: UserMessageData;
}

export interface AssistantTurnStartEvent extends BaseEvent {
  type: "assistant.turn_start";
  data: AssistantTurnStartData;
}

export interface AssistantTurnEndEvent extends BaseEvent {
  type: "assistant.turn_end";
  data: AssistantTurnEndData;
}

export interface AssistantMessageEvent extends BaseEvent {
  type: "assistant.message";
  data: AssistantMessageData;
}

export interface AssistantMessageDeltaEvent extends BaseEvent {
  type: "assistant.message_delta";
  data: AssistantMessageDeltaData;
}

export interface AssistantReasoningEvent extends BaseEvent {
  type: "assistant.reasoning";
  data: AssistantReasoningData;
}

export interface AssistantReasoningDeltaEvent extends BaseEvent {
  type: "assistant.reasoning_delta";
  data: AssistantReasoningDeltaData;
}

export interface ToolExecutionStartEvent extends BaseEvent {
  type: "tool.execution_start";
  data: ToolExecutionStartData;
}

export interface ToolExecutionCompleteEvent extends BaseEvent {
  type: "tool.execution_complete";
  data: ToolExecutionCompleteData;
}

export interface SessionBackgroundTasksChangedEvent extends BaseEvent {
  type: "session.background_tasks_changed";
  data: Record<string, unknown>;
}

export interface ResultEvent {
  type: "result";
  timestamp?: string;
  sessionId: string;
  exitCode: number;
  usage: ResultUsage;
}

export interface UnknownEvent extends BaseEvent {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

export type CopilotEvent =
  | SessionToolsUpdatedEvent
  | UserMessageEvent
  | AssistantTurnStartEvent
  | AssistantTurnEndEvent
  | AssistantMessageEvent
  | AssistantMessageDeltaEvent
  | AssistantReasoningEvent
  | AssistantReasoningDeltaEvent
  | ToolExecutionStartEvent
  | ToolExecutionCompleteEvent
  | SessionBackgroundTasksChangedEvent
  | ResultEvent
  | UnknownEvent;

// ---- Accumulated output ---------------------------------------------------

export interface ParsedAgentOutput {
  lastAiMessage: string | null;
  allAiMessages: string[];
  sessionId: string | null;
  exitCode: number | null;
  usage: {
    premiumRequests: number;
    totalApiDurationMs: number;
    sessionDurationMs: number;
  } | null;
  codeChanges: {
    linesAdded: number;
    linesRemoved: number;
    filesModified: string[];
  } | null;
  toolExecutions: { name: string; startedAt: string }[];
}

// ---- Known event types for the type guard ---------------------------------

const KNOWN_TYPES = new Set([
  "session.tools_updated",
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "assistant.message_delta",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "tool.execution_start",
  "tool.execution_complete",
  "session.background_tasks_changed",
  "result",
]);

// ---- Parser ---------------------------------------------------------------

export class CopilotJsonlParser {
  private allAiMessages: string[] = [];
  private sessionId: string | null = null;
  private exitCode: number | null = null;
  private usage: ParsedAgentOutput["usage"] = null;
  private codeChanges: ParsedAgentOutput["codeChanges"] = null;
  private toolExecutions: { name: string; startedAt: string }[] = [];

  /**
   * Parse a single line of JSONL output.
   * Returns null for blank lines, non-JSON lines (stderr, shell prompts, etc.).
   */
  parseLine(rawLine: string): CopilotEvent | null {
    const trimmed = rawLine.trim();
    if (!trimmed) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
      return null;
    }

    const event = this.toTypedEvent(parsed);
    this.updateState(event);
    return event;
  }

  /** Return the accumulated output gathered from all parsed events so far. */
  getResult(): ParsedAgentOutput {
    const lastAiMessage =
      this.allAiMessages.length > 0
        ? this.allAiMessages[this.allAiMessages.length - 1]
        : null;

    return {
      lastAiMessage,
      allAiMessages: [...this.allAiMessages],
      sessionId: this.sessionId,
      exitCode: this.exitCode,
      usage: this.usage ? { ...this.usage } : null,
      codeChanges: this.codeChanges
        ? { ...this.codeChanges, filesModified: [...this.codeChanges.filesModified] }
        : null,
      toolExecutions: this.toolExecutions.map((t) => ({ ...t })),
    };
  }

  // -- internals ------------------------------------------------------------

  private toTypedEvent(raw: Record<string, unknown>): CopilotEvent {
    const type = raw.type as string;

    if (!KNOWN_TYPES.has(type)) {
      return raw as unknown as UnknownEvent;
    }

    // `result` events have a flat structure (no `data` wrapper)
    if (type === "result") {
      return raw as unknown as ResultEvent;
    }

    return raw as unknown as CopilotEvent;
  }

  private updateState(event: CopilotEvent): void {
    switch (event.type) {
      case "assistant.message": {
        const e = event as AssistantMessageEvent;
        const { content, toolRequests } = e.data;
        const hasToolRequests = toolRequests && toolRequests.length > 0;
        if (content && !hasToolRequests) {
          this.allAiMessages.push(content);
        }
        break;
      }

      case "tool.execution_start": {
        const e = event as ToolExecutionStartEvent;
        this.toolExecutions.push({
          name: e.data.name,
          startedAt: e.timestamp ?? new Date().toISOString(),
        });
        break;
      }

      case "result": {
        const e = event as ResultEvent;
        this.sessionId = e.sessionId ?? null;
        this.exitCode = e.exitCode ?? null;

        if (e.usage) {
          this.usage = {
            premiumRequests: e.usage.premiumRequests,
            totalApiDurationMs: e.usage.totalApiDurationMs,
            sessionDurationMs: e.usage.sessionDurationMs,
          };
        }

        const raw = e as unknown as Record<string, unknown>;
        const changes = raw.usage &&
          typeof raw.usage === "object" &&
          "codeChanges" in (raw.usage as Record<string, unknown>)
          ? (raw.usage as Record<string, unknown>).codeChanges
          : (raw as Record<string, unknown>).codeChanges;

        if (changes && typeof changes === "object") {
          const c = changes as Record<string, unknown>;
          this.codeChanges = {
            linesAdded: (c.linesAdded as number) ?? 0,
            linesRemoved: (c.linesRemoved as number) ?? 0,
            filesModified: Array.isArray(c.filesModified)
              ? (c.filesModified as string[])
              : [],
          };
        }
        break;
      }

      default:
        break;
    }
  }
}
