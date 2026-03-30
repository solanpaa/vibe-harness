"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TerminalEvent } from "./event-parser";
import { stripOsc } from "./event-parser";
import { formatDuration } from "@/lib/format";

// ---- Event renderers ------------------------------------------------------

function MessageBlock({ content }: { content: string }) {
  return (
    <div className="rounded-lg px-4 py-3 my-2 border border-terminal-border bg-terminal-bg-elevated">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] font-semibold text-terminal-text-accent">Copilot</span>
      </div>
      <div className="text-[13px] text-terminal-text leading-relaxed prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
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
      <div className="text-[13px] text-terminal-text-muted break-words leading-relaxed prose prose-invert prose-sm max-w-none prose-headings:text-blue-300 prose-headings:text-[13px] prose-headings:font-semibold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-code:text-terminal-text prose-code:bg-terminal-bg-elevated prose-code:rounded prose-code:px-1 prose-code:text-[12px] prose-pre:bg-terminal-bg-elevated prose-pre:rounded prose-pre:my-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 150;
  const preview = content.slice(0, 150) + "…";

  return (
    <div
      className="rounded px-3 py-1.5 my-1 cursor-pointer hover:bg-terminal-bg-elevated transition-colors bg-terminal-bg-subtle"
      onClick={() => isLong && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-1">
        <span className="text-[10px] text-terminal-text-muted shrink-0 mt-0.5">›</span>
        {isLong && !expanded ? (
          <div className="text-[11px] text-terminal-text-muted italic leading-relaxed min-w-0">
            {preview}
          </div>
        ) : (
          <div className="text-[11px] text-terminal-text-muted italic leading-relaxed min-w-0 prose prose-invert prose-xs max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_pre]:my-1 [&_code]:text-[10px] [&_code]:bg-terminal-bg-elevated [&_strong]:text-terminal-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
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

/** Shorten long path values for display */
function shortenValue(value: string): string {
  return value
    .replace(/\/\S*\.vibe-harness-worktrees\/[^/\s]+\//g, "")
    .replace(/\/Users\/[^/]+\/[^/]+\/[^/]+\//g, "…/")
    .replace(/\/home\/[^/]+\/[^/]+\//g, "…/");
}

function ToolStartLine({ name, detail, args }: { name: string; detail: string; args?: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = args && Object.keys(args).length > 0;
  const truncated = detail.length > 80 ? detail.slice(0, 80) + "…" : detail;

  return (
    <div className="font-mono text-[11px] py-0.5 min-w-0">
      <div
        className={`flex items-baseline gap-1.5 ${canExpand ? "cursor-pointer" : ""}`}
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        <span className="text-terminal-text-muted shrink-0">
          {canExpand ? (
            <ChevronRight className={`inline h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          ) : (
            <span>{toolIcon(name)}</span>
          )}
        </span>
        <span className="text-terminal-text font-semibold shrink-0">{name}</span>
        {!expanded && detail && (
          <span className="text-terminal-text-muted truncate">{truncated}</span>
        )}
      </div>
      {expanded && args && (
        <div className="ml-5 mt-0.5 space-y-0.5 text-terminal-text-muted">
          {Object.entries(args).map(([key, value]) => {
            const strVal = typeof value === "string" ? value : JSON.stringify(value);
            const displayVal = shortenValue(strVal);
            return (
              <div key={key} className="flex gap-2 min-w-0">
                <span className="text-terminal-text shrink-0">{key}:</span>
                <span className="whitespace-pre-wrap break-all">{displayVal}</span>
              </div>
            );
          })}
        </div>
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

function SessionInfoLine({ text }: { text: string }) {
  return (
    <div className="font-mono text-[11px] py-0.5 text-terminal-text-muted flex items-center gap-1.5">
      <span className="opacity-50">⚙</span>
      <span>{text}</span>
    </div>
  );
}

export function renderEvent(ev: TerminalEvent, index: number) {
  switch (ev.kind) {
    case "message":
      return <MessageBlock key={index} content={ev.content} />;
    case "user_message":
      return <UserMessageBlock key={index} content={ev.content} />;
    case "session_info":
      return <SessionInfoLine key={index} text={ev.text} />;
    case "reasoning":
      return <ReasoningBlock key={index} content={ev.content} />;
    case "tool_start":
      return <ToolStartLine key={index} name={ev.name} detail={ev.detail} args={ev.args} />;
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
