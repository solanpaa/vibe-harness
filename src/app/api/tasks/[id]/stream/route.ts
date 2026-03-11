import { NextRequest } from "next/server";
import { getTaskSandbox } from "@/lib/services/task-manager";

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
      const sandbox = getTaskSandbox(id);

      if (!sandbox) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Task not found or not running" })}\n\n`)
        );
        controller.close();
        return;
      }

      // Send existing output
      for (const line of sandbox.output) {
        controller.enqueue(encoder.encode(formatSseMessage(line)));
      }

      // Stream new output
      const onOutput = (data: string) => {
        try {
          controller.enqueue(encoder.encode(formatSseMessage(data)));
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

      // Cleanup when client disconnects
      request.signal.addEventListener("abort", () => {
        sandbox.events.off("output", onOutput);
        sandbox.events.off("close", onClose);
        sandbox.events.off("error", onError);
      });
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
