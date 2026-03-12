"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Terminal, Loader2, TerminalSquare, Zap, Send } from "lucide-react";
import { toast } from "sonner";
import type { TerminalEvent } from "./event-parser";
import { mapJsonlEvent, parseLine } from "./event-parser";
import { renderEvent } from "./EventRenderers";

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
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
        setInput(message);
      } else {
        // Show the sent message as a user event in the terminal
        setStreamedEvents((prev) => [
          ...prev,
          { kind: "user_message", content: message },
        ]);
      }
    } catch {
      toast.error("Failed to send message");
      setInput(message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
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
        <div className="border-t px-3 py-2 bg-background">
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
          </div>
        </div>
      )}
    </div>
  );
}
