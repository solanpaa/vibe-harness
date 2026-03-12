"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Send, StopCircle, Loader2, Zap, Bot, User, Terminal } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TerminalEvent } from "./terminal/event-parser";
import { mapJsonlEvent } from "./terminal/event-parser";
import { renderEvent } from "./terminal/EventRenderers";

// ── Types ────────────────────────────────────────────────────────────

interface AcpMessage {
  role: "user" | "assistant" | "system";
  content: string;
  isIntervention: boolean;
  timestamp: string;
}

type ChatEvent =
  | { kind: "message"; msg: AcpMessage }
  | { kind: "terminal"; event: TerminalEvent }
  | { kind: "status"; status: string };

interface AcpChatPanelProps {
  taskId: string;
  status: string;
  sandboxId: string | null;
  onStreamClose?: () => void;
}

// ── Component ────────────────────────────────────────────────────────

export function AcpChatPanel({
  taskId,
  status,
  sandboxId,
  onStreamClose,
}: AcpChatPanelProps) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>("initializing");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onStreamCloseRef = useRef(onStreamClose);

  useEffect(() => {
    onStreamCloseRef.current = onStreamClose;
  }, [onStreamClose]);

  // ── SSE Connection ─────────────────────────────────────────────

  const closeStream = useCallback(() => {
    setIsStreaming(false);
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (status !== "running") {
      closeStream();
      return;
    }

    setIsStreaming(true);
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "acp_message") {
          setEvents((prev) => [
            ...prev,
            {
              kind: "message",
              msg: {
                role: data.role,
                content: data.content,
                isIntervention: data.isIntervention ?? false,
                timestamp: data.timestamp ?? new Date().toISOString(),
              },
            },
          ]);
        } else if (data.type === "acp_status") {
          setAgentStatus(data.status);
          setEvents((prev) => [...prev, { kind: "status", status: data.status }]);
        } else if (data.type === "acp_update") {
          // ACP updates get rendered as terminal events where possible
          if (data.kind === "tool_start") {
            const name = (data.data?.toolName as string) ?? (data.data?.name as string) ?? "tool";
            setEvents((prev) => [
              ...prev,
              { kind: "terminal", event: { kind: "tool_start", name, detail: "" } },
            ]);
          }
        } else if (data.type === "jsonl_event") {
          const mapped = mapJsonlEvent(data.event);
          if (mapped) {
            setEvents((prev) => [...prev, { kind: "terminal", event: mapped }]);
          }
        } else if (data.type === "close") {
          closeStream();
          onStreamCloseRef.current?.();
        } else if (data.type === "error") {
          toast.error(data.message);
          closeStream();
        }
      } catch {
        // Ignore parse errors
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

  // ── Auto-scroll ────────────────────────────────────────────────

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  // ── Send Message ───────────────────────────────────────────────

  async function handleSend() {
    const message = input.trim();
    if (!message || sending) return;

    setSending(true);
    setInput("");

    try {
      const res = await fetch(`/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Failed to send message");
        setInput(message); // restore
      }
    } catch {
      toast.error("Failed to send message");
      setInput(message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function handleCancel() {
    try {
      await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
      toast.success("Cancel requested");
    } catch {
      toast.error("Failed to cancel");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Render helpers ─────────────────────────────────────────────

  const isRunning = status === "running";
  const showInput = isRunning;

  const emptyMessage =
    status === "pending"
      ? "Task not started yet. Click Start to begin."
      : status === "running"
        ? "Connecting to ACP session..."
        : "Session ended.";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Scrollable chat area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 min-h-full space-y-1 bg-terminal-bg">
          {events.length === 0 ? (
            <span className="text-terminal-text-muted text-xs font-mono">
              {emptyMessage}
            </span>
          ) : (
            events.map((ev, i) => (
              <ChatEventRenderer key={i} event={ev} />
            ))
          )}
        </div>
      </div>

      {/* Input area */}
      {showInput && (
        <div className="border-t p-3 bg-background">
          <div className="flex gap-2">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type instruction to agent... (Enter to send)"
              className="min-h-[60px] max-h-[120px] resize-none text-sm"
              disabled={sending}
            />
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className="h-8"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Zap className="mr-1 h-3 w-3" />
                    Send
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancel}
                className="h-8"
              >
                <StopCircle className="mr-1 h-3 w-3" />
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat Event Renderer ──────────────────────────────────────────────

function ChatEventRenderer({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case "message":
      return <ChatBubble msg={event.msg} />;
    case "terminal":
      return renderEvent(event.event, Math.random());
    case "status":
      return null; // Status shown in header, not inline
    default:
      return null;
  }
}

function ChatBubble({ msg }: { msg: AcpMessage }) {
  if (msg.role === "user") {
    return (
      <div className="rounded-lg px-4 py-3 my-2 border border-blue-800/40 bg-blue-950/30">
        <div className="flex items-center gap-1.5 mb-1.5">
          <User className="h-3 w-3 text-blue-400" />
          <span className="text-[11px] font-semibold text-blue-400">
            You
          </span>
          {msg.isIntervention && (
            <Badge className="ml-1 bg-amber-900/40 text-amber-300 text-[9px] px-1 py-0 leading-tight">
              <Zap className="mr-0.5 h-2.5 w-2.5" />
              intervention
            </Badge>
          )}
        </div>
        <div className="text-[13px] text-terminal-text-muted break-words leading-relaxed prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>
      </div>
    );
  }

  if (msg.role === "assistant") {
    return (
      <div className="rounded-lg px-4 py-3 my-2 border border-terminal-border bg-terminal-bg-elevated">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Bot className="h-3 w-3 text-terminal-text-accent" />
          <span className="text-[11px] font-semibold text-terminal-text-accent">
            Copilot
          </span>
        </div>
        <div className="text-[13px] text-terminal-text whitespace-pre-wrap break-words leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }

  // System message
  return (
    <div className="text-[11px] text-terminal-text-muted italic text-center py-1">
      {msg.content}
    </div>
  );
}
