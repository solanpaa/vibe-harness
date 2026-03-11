"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Terminal, Loader2, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import AnsiToHtml from "ansi-to-html";

interface TerminalOutputProps {
  taskId: string;
  status: string; // "pending" | "running" | "awaiting_review" | "completed" | "failed"
  initialOutput: string | null;
  sandboxId: string | null;
  onStreamClose?: () => void;
}

const ANSI_COLORS = {
  0: "#1e1e1e",
  1: "#f87171",
  2: "#4ade80",
  3: "#facc15",
  4: "#60a5fa",
  5: "#c084fc",
  6: "#22d3ee",
  7: "#e5e7eb",
  8: "#6b7280",
  9: "#fca5a5",
  10: "#86efac",
  11: "#fde68a",
  12: "#93c5fd",
  13: "#d8b4fe",
  14: "#67e8f9",
  15: "#f9fafb",
};

// Strip OSC sequences (terminal title, etc.)
function stripOsc(line: string): string {
  return line.replace(/\]0;[^\x07\x1b]*(\x07|\x1b\\)?/g, "");
}

export function TerminalOutput({
  taskId,
  status,
  initialOutput,
  sandboxId,
  onStreamClose,
}: TerminalOutputProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onStreamCloseRef = useRef(onStreamClose);

  // Keep callback ref fresh without triggering effect re-runs
  useEffect(() => {
    onStreamCloseRef.current = onStreamClose;
  }, [onStreamClose]);

  const ansiConverter = useMemo(
    () =>
      new AnsiToHtml({
        fg: "#4ade80",
        bg: "#030712",
        newline: false,
        escapeXML: true,
        colors: ANSI_COLORS,
      }),
    [],
  );

  // Seed from initialOutput on mount / when it changes
  useEffect(() => {
    if (initialOutput) {
      setLines(initialOutput.split("\n"));
    }
  }, [initialOutput]);

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
      closeStream();
      return;
    }

    setIsStreaming(true);
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "output") {
          setLines((prev) => [...prev, data.data]);
        } else if (data.type === "close") {
          closeStream();
          onStreamCloseRef.current?.();
        } else if (data.type === "error") {
          toast.error(data.message);
          closeStream();
          onStreamCloseRef.current?.();
        }
      } catch {
        // Non-JSON payload — treat as raw output
        setLines((prev) => [...prev, event.data]);
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

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const renderLine = useCallback(
    (line: string, index: number) => {
      const html = ansiConverter.toHtml(stripOsc(line));
      return <div key={index} dangerouslySetInnerHTML={{ __html: html }} />;
    },
    [ansiConverter],
  );

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
          className="text-green-400 font-mono text-xs p-4 min-h-full whitespace-pre-wrap"
        >
          {lines.length === 0 ? (
            <span className="text-gray-600">{emptyMessage}</span>
          ) : (
            lines.map(renderLine)
          )}
        </div>
      </div>
    </div>
  );
}
