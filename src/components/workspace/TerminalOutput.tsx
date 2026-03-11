"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Terminal, Loader2, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

// ---- Local event types (client-side, no server imports) -------------------

type TerminalEvent =
  | { kind: "message"; content: string }
  | { kind: "tool_start"; name: string; detail: string }
  | { kind: "tool_complete"; name: string }
  | { kind: "result"; exitCode: number; premiumRequests?: number; durationMs?: number }
  | { kind: "raw"; text: string };

// ---- Helpers --------------------------------------------------------------

/** Strip OSC sequences (terminal title, etc.) for legacy raw output */
function stripOsc(line: string): string {
  return line.replace(/\]0;[^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

/** Extract a short detail string for a tool_start event */
function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
    case "shell":
      return (args.command as string) ?? (args.cmd as string) ?? "";
    case "edit":
    case "view":
    case "create":
      return (args.path as string) ?? (args.file_path as string) ?? "";
    case "grep":
      return (args.pattern as string) ?? "";
    case "glob":
      return (args.pattern as string) ?? "";
    default: {
      // Show first string argument as a short hint
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
function mapJsonlEvent(event: Record<string, unknown>): TerminalEvent | null {
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
    case "tool.execution_start": {
      // Skip sub-agent tool events (nested tools have parentToolCallId)
      if (data.parentToolCallId) return null;
      const name = (data.toolName as string) ?? (data.name as string) ?? "tool";
      // Skip internal tools that don't need display
      if (name === "report_intent") return null;
      const args = (data.arguments as Record<string, unknown>) ?? {};
      return { kind: "tool_start", name, detail: toolDetail(name, args) };
    }
    case "tool.execution_complete": {
      // Skip sub-agent tool completions
      if (data.parentToolCallId) return null;
      const name = (data.toolName as string) ?? (data.name as string) ?? "tool";
      if (name === "report_intent") return null;
      return { kind: "tool_complete", name };
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
    // Skip these event types entirely
    case "assistant.message_delta":
    case "assistant.reasoning":
    case "assistant.reasoning_delta":
    case "assistant.turn_start":
    case "assistant.turn_end":
    case "user.message":
    case "session.tools_updated":
    case "session.background_tasks_changed":
      return null;
    default:
      return null;
  }
}

/** Parse a single raw output line into a TerminalEvent (for initialOutput reconstruction) */
function parseLine(line: string): TerminalEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return mapJsonlEvent(parsed);
    }
  } catch {
    // Not JSON — fall through to raw
  }
  return { kind: "raw", text: line };
}

// ---- Event renderers ------------------------------------------------------

function MessageBlock({ content }: { content: string }) {
  return (
    <div className="rounded-md px-3 py-2 my-1" style={{ backgroundColor: "#111827" }}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] font-medium text-gray-400">🤖 Copilot</span>
      </div>
      <div className="text-sm text-gray-100 whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </div>
    </div>
  );
}

function ToolStartLine({ name, detail }: { name: string; detail: string }) {
  const truncated = detail.length > 120 ? detail.slice(0, 120) + "…" : detail;
  return (
    <div className="font-mono text-xs text-gray-500 py-0.5 truncate">
      <span className="mr-1.5">▶</span>
      <span className="text-gray-400">{name}</span>
      {truncated && <span className="ml-1.5 text-gray-600">{truncated}</span>}
    </div>
  );
}

function ToolCompleteLine({ name }: { name: string }) {
  return (
    <div className="font-mono text-xs text-green-600 py-0.5">
      <span className="mr-1.5">✓</span>
      <span>{name}</span>
    </div>
  );
}

function ResultCard({
  exitCode,
  premiumRequests,
  durationMs,
}: {
  exitCode: number;
  premiumRequests?: number;
  durationMs?: number;
}) {
  const ok = exitCode === 0;
  const borderColor = ok ? "border-green-800" : "border-red-800";
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  };

  return (
    <div
      className={`mt-2 rounded-md border ${borderColor} px-3 py-2`}
      style={{ backgroundColor: "#0a0f1a" }}
    >
      <div className="text-xs font-medium text-gray-300 mb-1">Session Result</div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-400">
        <span>
          Exit code:{" "}
          <span className={ok ? "text-green-400" : "text-red-400"}>{exitCode}</span>
        </span>
        {premiumRequests != null && (
          <span>Premium requests: <span className="text-gray-200">{premiumRequests}</span></span>
        )}
        {durationMs != null && (
          <span>Duration: <span className="text-gray-200">{formatDuration(durationMs)}</span></span>
        )}
      </div>
    </div>
  );
}

function RawLine({ text }: { text: string }) {
  return (
    <div className="font-mono text-xs text-green-400 whitespace-pre-wrap break-all">
      {stripOsc(text)}
    </div>
  );
}

function renderEvent(ev: TerminalEvent, index: number) {
  switch (ev.kind) {
    case "message":
      return <MessageBlock key={index} content={ev.content} />;
    case "tool_start":
      return <ToolStartLine key={index} name={ev.name} detail={ev.detail} />;
    case "tool_complete":
      return <ToolCompleteLine key={index} name={ev.name} />;
    case "result":
      return (
        <ResultCard
          key={index}
          exitCode={ev.exitCode}
          premiumRequests={ev.premiumRequests}
          durationMs={ev.durationMs}
        />
      );
    case "raw":
      return <RawLine key={index} text={ev.text} />;
  }
}

// ---- Main component -------------------------------------------------------

interface TerminalOutputProps {
  taskId: string;
  status: string;
  initialOutput: string | null;
  sandboxId: string | null;
  onStreamClose?: () => void;
}

export function TerminalOutput({
  taskId,
  status,
  initialOutput,
  sandboxId,
  onStreamClose,
}: TerminalOutputProps) {
  // Parse initialOutput outside of an effect to avoid setState-in-effect
  const initialEvents = useMemo(() => {
    if (!initialOutput) return [];
    return initialOutput
      .split("\n")
      .map(parseLine)
      .filter((e): e is TerminalEvent => e !== null);
  }, [initialOutput]);

  const [streamedEvents, setStreamedEvents] = useState<TerminalEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onStreamCloseRef = useRef(onStreamClose);

  const events = isStreaming || streamedEvents.length > 0
    ? streamedEvents
    : initialEvents;

  useEffect(() => {
    onStreamCloseRef.current = onStreamClose;
  }, [onStreamClose]);

  // SSE connection
  const closeStream = useCallback(() => {
    setIsStreaming(false);
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (status !== "running") {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing streaming state with task status
      setIsStreaming(false);
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing streaming state with task status
    setIsStreaming(true);
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "jsonl_event") {
          const mapped = mapJsonlEvent(data.event);
          if (mapped) {
            setStreamedEvents((prev) => [...prev, mapped]);
          }
        } else if (data.type === "output") {
          setStreamedEvents((prev) => [...prev, { kind: "raw", text: data.data }]);
        } else if (data.type === "close") {
          closeStream();
          onStreamCloseRef.current?.();
        } else if (data.type === "error") {
          toast.error(data.message);
          closeStream();
          onStreamCloseRef.current?.();
        }
      } catch {
        setStreamedEvents((prev) => [...prev, { kind: "raw", text: event.data }]);
      }
    };

    es.onerror = () => {
      closeStream();
      onStreamCloseRef.current?.();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [status, taskId, closeStream]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const showShellButton =
    sandboxId &&
    (status === "running" || status === "completed" || status === "failed");

  const handleCopyShellCommand = useCallback(() => {
    const cmd = `GITHUB_TOKEN=$(gh auth token) docker sandbox run ${sandboxId}`;
    navigator.clipboard.writeText(cmd);
    toast.success(
      "Copied! Paste in your terminal to open a shell in the sandbox.",
    );
  }, [sandboxId]);

  const emptyMessage =
    status === "pending"
      ? "Task not started yet. Click Start to begin."
      : status === "running"
        ? "Connecting to output stream..."
        : "No output recorded.";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          <span className="text-sm font-semibold">Output</span>
        </div>
        <div className="flex items-center gap-2">
          {showShellButton && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyShellCommand}
            >
              <TerminalSquare className="mr-1 h-3 w-3" />
              Open Shell
            </Button>
          )}
          {isStreaming && (
            <Badge className="bg-blue-100 text-blue-800">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Live
            </Badge>
          )}
        </div>
      </div>

      {/* Scrollable output */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          style={{ backgroundColor: "#030712" }}
          className="p-4 min-h-full space-y-0.5"
        >
          {events.length === 0 ? (
            <span className="text-gray-600 text-xs font-mono">{emptyMessage}</span>
          ) : (
            events.map(renderEvent)
          )}
        </div>
      </div>
    </div>
  );
}
