import { NextRequest } from "next/server";
import { getTaskSandbox, getTaskAcpSession } from "@/lib/services/task-manager";

/**
 * Try to parse a raw output line as a JSONL event from Copilot CLI.
 * Returns the parsed object when the line is valid JSON with a `type` field,
 * or null for non-JSON lines (stderr, shell prompts, etc.).
 */
function tryParseJsonlEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON
  }
  return null;
}

function formatSseMessage(line: string): string {
  const event = tryParseJsonlEvent(line);
  if (event) {
    return `data: ${JSON.stringify({ type: "jsonl_event", event })}\n\n`;
  }
  // Skip lines that look like broken/truncated JSONL — raw JSON is never useful to stream
  const trimmed = line.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith('"type"')) {
    return "";
  }
  // Skip Copilot CLI stderr progress indicators (✓tool, spinner chars, etc.)
  if (/^[✓▶⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) {
    return "";
  }
  if (!trimmed) return "";
  return `data: ${JSON.stringify({ type: "output", data: line })}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Try ACP session first, then legacy sandbox
      const acpSession = getTaskAcpSession(id);
      if (acpSession) {
        return startAcpStream(controller, encoder, acpSession, request);
      }

      const sandbox = getTaskSandbox(id);
      if (!sandbox) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Task not found or not running" })}\n\n`)
        );
        controller.close();
        return;
      }

      // Legacy sandbox streaming (unchanged)
      startLegacyStream(controller, encoder, sandbox, request);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function startLegacyStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  sandbox: ReturnType<typeof getTaskSandbox> & {},
  request: NextRequest
) {
  // Send existing output
  for (const line of sandbox.output) {
    const msg = formatSseMessage(line);
    if (msg) {
      controller.enqueue(encoder.encode(msg));
    }
  }

  // Stream new output
  const onOutput = (data: string) => {
    try {
      const msg = formatSseMessage(data);
      if (msg) {
        controller.enqueue(encoder.encode(msg));
      }
    } catch {
      // Stream closed
    }
  };

  const onClose = (code: number) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "close", code })}\n\n`)
      );
      controller.close();
    } catch {
      // Stream already closed
    }
  };

  const onError = (err: Error) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)
      );
      controller.close();
    } catch {
      // Stream already closed
    }
  };

  sandbox.events.on("output", onOutput);
  sandbox.events.on("close", onClose);
  sandbox.events.on("error", onError);

  request.signal.addEventListener("abort", () => {
    sandbox.events.off("output", onOutput);
    sandbox.events.off("close", onClose);
    sandbox.events.off("error", onError);
  });
}

function startAcpStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  session: NonNullable<ReturnType<typeof getTaskAcpSession>>,
  request: NextRequest
) {
  // Send existing messages as conversation history
  for (const msg of session.messages) {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({
          type: "acp_message",
          role: msg.role,
          content: msg.content,
          isIntervention: msg.metadata?.isIntervention ?? false,
          timestamp: msg.timestamp,
        })}\n\n`)
      );
    } catch {
      // Stream closed
    }
  }

  // Send existing JSONL output for backward-compatible event rendering
  for (const line of session.output) {
    const msg = formatSseMessage(line);
    if (msg) {
      try {
        controller.enqueue(encoder.encode(msg));
      } catch {
        // Stream closed
      }
    }
  }

  // Send current status
  try {
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify({
        type: "acp_status",
        status: session.status,
        executionMode: "acp",
      })}\n\n`)
    );
  } catch {
    // Stream closed
  }

  // Stream ACP updates
  const onUpdate = (update: { kind: string; data: Record<string, unknown> }) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({
          type: "acp_update",
          ...update,
        })}\n\n`)
      );
    } catch {
      // Stream closed
    }
  };

  // Stream conversation messages
  const onMessage = (msg: { role: string; content: string; metadata?: { isIntervention?: boolean } }) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({
          type: "acp_message",
          role: msg.role,
          content: msg.content,
          isIntervention: msg.metadata?.isIntervention ?? false,
          timestamp: new Date().toISOString(),
        })}\n\n`)
      );
    } catch {
      // Stream closed
    }
  };

  // Stream status changes
  const onStatus = (status: string) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({
          type: "acp_status",
          status,
          executionMode: "acp",
        })}\n\n`)
      );
    } catch {
      // Stream closed
    }
  };

  // Forward JSONL events from ACP session
  const onJsonlEvent = (event: Record<string, unknown>) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "jsonl_event", event })}\n\n`)
      );
    } catch {
      // Stream closed
    }
  };

  const onClose = (code: number) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "close", code })}\n\n`)
      );
      controller.close();
    } catch {
      // Stream already closed
    }
  };

  const onError = (err: Error) => {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)
      );
      controller.close();
    } catch {
      // Stream already closed
    }
  };

  session.events.on("update", onUpdate);
  session.events.on("message", onMessage);
  session.events.on("status", onStatus);
  session.events.on("jsonl_event", onJsonlEvent);
  session.events.on("close", onClose);
  session.events.on("error", onError);

  request.signal.addEventListener("abort", () => {
    session.events.off("update", onUpdate);
    session.events.off("message", onMessage);
    session.events.off("status", onStatus);
    session.events.off("jsonl_event", onJsonlEvent);
    session.events.off("close", onClose);
    session.events.off("error", onError);
  });
}
