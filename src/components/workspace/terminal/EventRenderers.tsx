"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TerminalEvent } from "./event-parser";
import { stripOsc } from "./event-parser";

// ---- Event renderers ------------------------------------------------------

function MessageBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg px-4 py-3 my-2 border border-terminal-border bg-terminal-bg-elevated">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] font-semibold text-terminal-text-accent">Copilot</span>
      </div>
      <div className="text-[13px] text-terminal-text whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </div>
    </div>
  );
}

function UserMessageBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg px-4 py-3 my-2 border border-blue-800/40 bg-blue-950/30">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] font-semibold text-blue-400">Prompt</span>
      </div>
      <div className="text-[13px] text-terminal-text-muted whitespace-pre-wrap break-words leading-relaxed">
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
      className="rounded px-3 py-1.5 my-1 cursor-pointer hover:bg-terminal-bg-elevated transition-colors bg-terminal-bg-subtle"
      onClick={() => isLong && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-1">
        <span className="text-[10px] text-terminal-text-muted shrink-0 mt-0.5">›</span>
        <div className="text-[11px] text-terminal-text-muted italic leading-relaxed min-w-0 reasoning-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <span>{children} </span>,
              strong: ({ children }) => <strong className="text-terminal-text font-semibold">{children}</strong>,
              em: ({ children }) => <em>{children}</em>,
              code: ({ children }) => <code className="text-terminal-text bg-terminal-bg-elevated rounded px-1 text-[10px]">{children}</code>,
              a: ({ children }) => <span className="text-terminal-text">{children}</span>,
              ul: ({ children }) => <span>{children}</span>,
              ol: ({ children }) => <span>{children}</span>,
              li: ({ children }) => <span>• {children} </span>,
            }}
          >
            {display}
          </ReactMarkdown>
        </div>
        {isLong && (
          <ChevronRight className={`h-3 w-3 text-terminal-text-muted shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
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
      <span className="text-terminal-text-muted shrink-0">{icon}</span>
      <span className="text-terminal-text font-semibold shrink-0">{name}</span>
      {truncated && (
        <span className="text-terminal-text-muted truncate">{truncated}</span>
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
      className={`mt-3 rounded-lg border px-4 py-2.5 bg-terminal-bg-subtle ${ok ? "border-green-800/60" : "border-red-800/60"}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-terminal-text-muted">
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
    <div className="font-mono text-xs text-terminal-text-success whitespace-pre-wrap break-all">
      {stripOsc(text)}
    </div>
  );
}

export function renderEvent(ev: TerminalEvent, index: number) {
  switch (ev.kind) {
    case "message":
      return <MessageBlock key={index} content={ev.content} />;
    case "user_message":
      return <UserMessageBlock key={index} content={ev.content} />;
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
