// ---------------------------------------------------------------------------
// AI SDK type compatibility shim
//
// Provides the types that AI Elements components expect from the "ai" package
// without requiring the full AI SDK installation. These are minimal type
// definitions matching what the components actually use.
// ---------------------------------------------------------------------------

/** Minimal UIMessage type matching @ai-sdk/react useChat() output */
export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: string; [key: string]: unknown }
  >;
}

/** Chat status from useChat() */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/** File attachment from AI SDK */
export interface FileUIPart {
  type: "file";
  name?: string;
  mediaType?: string;
  url: string;
}

/** Source document from AI SDK */
export interface SourceDocumentUIPart {
  type: "source";
  source: {
    title?: string;
    url?: string;
    sourceType?: string;
    id?: string;
    providerMetadata?: Record<string, unknown>;
  };
}

/** Tool invocation state */
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

/** Tool UI part from AI SDK */
export interface ToolUIPart<_TTools extends Record<string, { input: unknown; output: unknown }> = Record<string, { input: unknown; output: unknown }>> {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

/** Dynamic tool UI part */
export interface DynamicToolUIPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}
