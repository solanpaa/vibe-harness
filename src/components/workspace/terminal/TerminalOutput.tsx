"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Terminal, Loader2, TerminalSquare, Zap, Send, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import type { TerminalEvent } from "./event-parser";
import { mapJsonlEvent, parseLine, toolDetail } from "./event-parser";
import { renderEvent } from "./EventRenderers";
import { isTerminalTask, isActiveTask } from "@/lib/status-config";

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
  // Parse initialOutput — handles both JSONL format and conversation format
  const initialEvents = useMemo(() => {
    if (!initialOutput) return [];

    // Check if output is in conversation format ([user]/[assistant] blocks)
    if (initialOutput.startsWith("[user]") || initialOutput.startsWith("[assistant]")) {
      const events: TerminalEvent[] = [];
      // Split on role markers
      const blocks = initialOutput.split(/\n\n(?=\[(user|assistant)\])/);
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("[user] ")) {
          events.push({ kind: "user_message", content: trimmed.slice(7) });
        } else if (trimmed.startsWith("[assistant] ")) {
          events.push({ kind: "message", content: trimmed.slice(12) });
        } else {
          events.push({ kind: "raw", text: trimmed });
        }
      }
      return events;
    }

    // Fall back to JSONL parsing
    return initialOutput
      .split("\n")
      .map(parseLine)
      .filter((e): e is TerminalEvent => e !== null);
  }, [initialOutput]);

  const [streamedEvents, setStreamedEvents] = useState<TerminalEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [autoCompleting, setAutoCompleting] = useState(false);
  const [userIntervened, setUserIntervened] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onStreamCloseRef = useRef(onStreamClose);
  // Track index of current accumulating message/reasoning block
  const msgAccumIdx = useRef<number>(-1);
  const reasonAccumIdx = useRef<number>(-1);

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
        } else if (data.type === "acp_message") {
          // ACP conversation messages
          if (data.role === "assistant" && data.content) {
            setStreamedEvents((prev) => [...prev, { kind: "message", content: data.content }]);
          } else if (data.role === "user" && data.content) {
            setStreamedEvents((prev) => [...prev, { kind: "user_message", content: data.content }]);
          }
        } else if (data.type === "acp_update") {
          // ACP protocol updates (tool calls, reasoning, text deltas)
          if (data.kind === "assistant_message_delta" && data.data?.text) {
            const text = data.data.text as string;
            setStreamedEvents((prev) => {
              const idx = msgAccumIdx.current;
              if (idx >= 0 && idx < prev.length && prev[idx].kind === "message") {
                const updated = [...prev];
                updated[idx] = { kind: "message", content: (prev[idx] as { content: string }).content + text };
                return updated;
              }
              // Start new message block
              msgAccumIdx.current = prev.length;
              return [...prev, { kind: "message" as const, content: text }];
            });
          } else if (data.kind === "reasoning" && data.data?.text) {
            const text = data.data.text as string;
            setStreamedEvents((prev) => {
              const idx = reasonAccumIdx.current;
              if (idx >= 0 && idx < prev.length && prev[idx].kind === "reasoning") {
                const updated = [...prev];
                updated[idx] = { kind: "reasoning", content: (prev[idx] as { content: string }).content + text };
                return updated;
              }
              reasonAccumIdx.current = prev.length;
              return [...prev, { kind: "reasoning" as const, content: text }];
            });
          } else if (data.kind === "tool_start") {
            // Tool call breaks the current message accumulation
            msgAccumIdx.current = -1;
            reasonAccumIdx.current = -1;
            const name = data.data?.name || data.data?.detail?.split(" ")[0] || "tool";
            const args = (data.data?.args || data.data?.input || data.data?.arguments || {}) as Record<string, unknown>;
            const detail = toolDetail(String(name), args);
            setStreamedEvents((prev) => [...prev, { kind: "tool_start" as const, name: String(name), detail, args }]);
          } else if (data.kind === "tool_complete" || data.kind === "tool_call_update") {
            // Tool done — next text starts a new message
            msgAccumIdx.current = -1;
          } else if (data.kind === "turn_end") {
            // Turn ended — reset accumulators
            msgAccumIdx.current = -1;
            reasonAccumIdx.current = -1;
          } else if (data.kind === "auto_complete_pending") {
            setAutoCompleting(true);
          } else if (data.kind === "auto_complete_cancelled") {
            setAutoCompleting(false);
          } else if (data.kind === "boot" && data.data?.text) {
            setStreamedEvents((prev) => [...prev, { kind: "raw" as const, text: data.data.text }]);
          }
        } else if (data.type === "acp_status") {
          // Status updates — show as session info
          if (data.status === "ready" || data.status === "busy") {
            setStreamedEvents((prev) => [...prev, { kind: "session_info", text: `Agent: ${data.status}` }]);
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
      : status === "running"
        ? "Connecting to output stream..."
        : "No output recorded.";

  async function handleSend() {
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setInput("");
    setUserIntervened(true);
    setAutoCompleting(false);
    try {
      const res = await fetch(`/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Failed to send message");
        setInput(message);
      } else {
        setStreamedEvents((prev) => [
          ...prev,
          { kind: "user_message", content: message },
        ]);
        msgAccumIdx.current = -1;
        reasonAccumIdx.current = -1;
      }
    } catch {
      toast.error("Failed to send message");
      setInput(message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function handleComplete() {
    try {
      await fetch(`/api/tasks/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast.success("Stage completing...");
    } catch {
      toast.error("Failed to complete stage");
    }
  }

  async function handleCancelAutoComplete() {
    setAutoCompleting(false);
    setUserIntervened(true);
    try {
      await fetch(`/api/tasks/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_auto_complete" }),
      });
    } catch {
      // Non-critical
    }
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const isRunning = status === "running";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Scrollable output */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          className="p-4 min-h-full space-y-0.5 bg-terminal-bg"
        >
          {events.length === 0 ? (
            <span className="text-terminal-text-muted text-xs font-mono">{emptyMessage}</span>
          ) : (
            events.map(renderEvent)
          )}
        </div>
      </div>

      {/* Intervention input — guide the agent while it's running */}
      {isRunning && (
        <div className="border-t px-3 py-2 bg-background space-y-2">
          {/* Auto-complete banner */}
          {autoCompleting && (
            <div className="flex items-center justify-between rounded-md bg-amber-950/30 border border-amber-800/40 px-3 py-1.5">
              <span className="text-[12px] text-amber-300 flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Auto-completing stage…
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px] px-2"
                onClick={handleCancelAutoComplete}
              >
                Cancel &amp; Keep Editing
              </Button>
            </div>
          )}

          <div className="flex gap-2 items-end">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Guide the agent… (Enter to send, Shift+Enter for newline)"
              className="min-h-[40px] max-h-[100px] resize-none text-sm flex-1"
              disabled={sending}
              rows={1}
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="h-9 px-3 shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Zap className="mr-1 h-3.5 w-3.5" />
                  Send
                </>
              )}
            </Button>
            {/* Show Complete button when user has intervened */}
            {userIntervened && !autoCompleting && (
              <Button
                size="sm"
                variant="secondary"
                onClick={handleComplete}
                className="h-9 px-3 shrink-0"
              >
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                Complete
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
