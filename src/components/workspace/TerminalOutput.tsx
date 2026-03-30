"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, TerminalSquare, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isTerminalTask, isActiveTask } from "@/lib/status-config";
import { formatDuration } from "@/lib/format";

// ---- Local event types (client-side, no server imports) -------------------

type TerminalEvent =
  | { kind: "message"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_start"; name: string; detail: string }
  | { kind: "result"; exitCode: number; premiumRequests?: number; durationMs?: number }
  | { kind: "raw"; text: string };

// ---- Helpers --------------------------------------------------------------

/** Strip OSC sequences (terminal title, etc.) for legacy raw output */
function stripOsc(line: string): string {
  return line.replace(/\]0;[^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

/** Shorten long file paths — keep last 2-3 segments */
function shortenPath(p: string): string {
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
function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
    case "shell": {
      const cmd = (args.command as string) ?? (args.cmd as string) ?? "";
      // Shorten paths within bash commands
      return cmd.replace(/\/\S*\.vibe-harness-worktrees\/[^/\s]+\//g, "");
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
    case "tool.execution_complete":
    case "assistant.message_delta":
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
    if (trimmed.startsWith("{") || trimmed.startsWith('"type"')) {
      return null;
    }
  }

  if (/^[✓▶⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) return null;
  if (trimmed === "tool" || trimmed.startsWith("Compiling")) return null;

  return { kind: "raw", text: line };
}

// ---- Event renderers ------------------------------------------------------

function MessageBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg px-4 py-3 my-2 border border-gray-700/50" style={{ backgroundColor: "#111827" }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] font-semibold text-blue-400">Copilot</span>
      </div>
      <div className="text-[13px] text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </div>
    </div>
  );
}

function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 150;
  const display = isLong && !expanded ? content.slice(0, 150) + "…" : content;

  return (
    <div
      className="rounded px-3 py-1.5 my-1 cursor-pointer hover:bg-gray-800/50 transition-colors"
      style={{ backgroundColor: "#080c14" }}
      onClick={() => isLong && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-1">
        <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">›</span>
        <div className="text-[11px] text-gray-500 italic leading-relaxed min-w-0 reasoning-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <span>{children} </span>,
              strong: ({ children }) => <strong className="text-gray-400 font-semibold">{children}</strong>,
              em: ({ children }) => <em>{children}</em>,
              code: ({ children }) => <code className="text-gray-400 bg-gray-800/50 rounded px-1 text-[10px]">{children}</code>,
              a: ({ children }) => <span className="text-gray-400">{children}</span>,
              ul: ({ children }) => <span>{children}</span>,
              ol: ({ children }) => <span>{children}</span>,
              li: ({ children }) => <span>• {children} </span>,
            }}
          >
            {display}
          </ReactMarkdown>
        </div>
        {isLong && (
          <ChevronRight className={`h-3 w-3 text-gray-600 shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
      </div>
    </div>
  );
}

/** Tool name → icon mapping */
function toolIcon(name: string): string {
  switch (name) {
    case "bash":
    case "shell":
      return "$";
    case "edit":
      return "✏";
    case "view":
    case "read_bash":
      return "↗";
    case "create":
      return "+";
    case "grep":
    case "glob":
      return "🔍";
    case "task":
      return "⚡";
    case "sql":
      return "⊞";
    default:
      return "▶";
  }
}

function ToolStartLine({ name, detail }: { name: string; detail: string }) {
  const truncated = detail.length > 100 ? detail.slice(0, 100) + "…" : detail;
  const icon = toolIcon(name);

  return (
    <div className="font-mono text-[11px] py-0.5 flex items-baseline gap-1.5 min-w-0">
      <span className="text-gray-600 shrink-0">{icon}</span>
      <span className="text-gray-400 font-semibold shrink-0">{name}</span>
      {truncated && (
        <span className="text-gray-600 truncate">{truncated}</span>
      )}
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

  return (
    <div
      className={`mt-3 rounded-lg border px-4 py-2.5 ${ok ? "border-green-800/60" : "border-red-800/60"}`}
      style={{ backgroundColor: "#0a0f1a" }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
          <span className={ok ? "text-green-400" : "text-red-400"}>
            {ok ? "Completed" : `Failed (${exitCode})`}
          </span>
        </span>
        {premiumRequests != null && (
          <span>
            {premiumRequests} premium {premiumRequests === 1 ? "request" : "requests"}
          </span>
        )}
        {durationMs != null && (
          <span>{formatDuration(durationMs)}</span>
        )}
      </div>
    </div>
  );
}

function RawLine({ text }: { text: string }) {
  return (
    <div className="font-mono text-xs text-green-400/70 whitespace-pre-wrap break-all">
      {stripOsc(text)}
    </div>
  );
}

function renderEvent(ev: TerminalEvent, index: number) {
  switch (ev.kind) {
    case "message":
      return <MessageBlock key={index} content={ev.content} />;
    case "reasoning":
      return <ReasoningBlock key={index} content={ev.content} />;
    case "tool_start":
      return <ToolStartLine key={index} name={ev.name} detail={ev.detail} />;
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
    (status === "running" || isTerminalTask(status));

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
      : isActiveTask(status)
        ? "Connecting to output stream..."
        : "No output recorded.";

  return (
    <div className="flex flex-col flex-1 min-h-0">
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
