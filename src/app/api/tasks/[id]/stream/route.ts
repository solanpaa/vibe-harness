import { NextRequest } from "next/server";
import { getTaskAcpSession } from "@/lib/services/task-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const session = getTaskAcpSession(id);
      if (!session) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Task not found or not running" })}\n\n`)
        );
        controller.close();
        return;
      }

      startAcpStream(controller, encoder, session, request);
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

function startAcpStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  session: NonNullable<ReturnType<typeof getTaskAcpSession>>,
  request: NextRequest
) {
  // Replay buffered events — this restores the full UI state on reconnect
  for (const event of session.eventLog) {
    try {
      if (event.kind === "message") {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({
            type: "acp_message",
            role: event.data.role,
            content: event.data.content,
            isIntervention: event.data.isIntervention ?? false,
            timestamp: event.timestamp,
          })}\n\n`)
        );
      } else if (event.kind === "status") {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({
            type: "acp_status",
            status: event.data.status,
            executionMode: "acp",
          })}\n\n`)
        );
      } else {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({
            type: "acp_update",
            kind: event.kind,
            data: event.data,
          })}\n\n`)
        );
      }
    } catch {
      // Stream closed
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
