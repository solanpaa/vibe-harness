import { useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { useStreamingStore } from "../../stores/streaming";
import type { RunOutputMessage } from "@vibe-harness/shared";

interface RunConversationProps {
  runId: string;
  isRunning: boolean;
}

// Group consecutive events into renderable blocks
interface MessageBlock {
  id: string;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "thought" | "system" | "session_boundary";
  content: string;
  stageName: string;
  timestamp: string;
  toolName?: string;
  toolArgs?: string;
  isIntervention?: boolean;
}

function eventsToBlocks(events: RunOutputMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let pendingAssistant: { content: string; stageName: string; timestamp: string } | null = null;

  const flushAssistant = () => {
    if (pendingAssistant) {
      blocks.push({
        id: `assistant-${blocks.length}`,
        type: "assistant",
        content: pendingAssistant.content,
        stageName: pendingAssistant.stageName,
        timestamp: pendingAssistant.timestamp,
      });
      pendingAssistant = null;
    }
  };

  for (const event of events) {
    const { data, stageName } = event;
    const ts = data.timestamp ?? new Date().toISOString();

    switch (data.eventType) {
      case "agent_message": {
        if (!pendingAssistant) {
          pendingAssistant = { content: "", stageName, timestamp: ts };
        }
        pendingAssistant.content += data.content;
        break;
      }
      case "agent_thought": {
        flushAssistant();
        blocks.push({
          id: `thought-${blocks.length}`,
          type: "thought",
          content: data.content,
          stageName,
          timestamp: ts,
        });
        break;
      }
      case "tool_call": {
        flushAssistant();
        blocks.push({
          id: `tool-${blocks.length}`,
          type: "tool_call",
          content: data.content,
          stageName,
          timestamp: ts,
          toolName: data.metadata?.toolName,
          toolArgs: data.metadata?.toolArgs
            ? JSON.stringify(data.metadata.toolArgs, null, 2)
            : undefined,
        });
        break;
      }
      case "tool_result": {
        blocks.push({
          id: `tool-result-${blocks.length}`,
          type: "tool_result",
          content: data.content,
          stageName,
          timestamp: ts,
          toolName: data.metadata?.toolName,
        });
        break;
      }
      case "intervention": {
        flushAssistant();
        blocks.push({
          id: `user-${blocks.length}`,
          type: "user",
          content: data.content,
          stageName,
          timestamp: ts,
          isIntervention: true,
        });
        break;
      }
      case "session_update": {
        flushAssistant();
        blocks.push({
          id: `session-${blocks.length}`,
          type: "session_boundary",
          content: data.content,
          stageName,
          timestamp: ts,
        });
        break;
      }
      case "system_prompt": {
        // Usually not shown, but include as system
        flushAssistant();
        blocks.push({
          id: `system-${blocks.length}`,
          type: "system",
          content: data.content,
          stageName,
          timestamp: ts,
        });
        break;
      }
      case "result": {
        flushAssistant();
        break;
      }
    }
  }

  flushAssistant();
  return blocks;
}

function AssistantMessage({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  if (isStreaming) {
    return (
      <Streamdown plugins={{ code }} isAnimating={true}>
        {content}
      </Streamdown>
    );
  }
  return (
    <Streamdown plugins={{ code }}>{content}</Streamdown>
  );
}

function ToolCallBlock({ block }: { block: MessageBlock }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-zinc-700/50 rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs bg-zinc-800/50 hover:bg-zinc-800 transition-colors text-left"
      >
        <span className="text-zinc-500">{expanded ? "▾" : "▸"}</span>
        <span className="text-blue-400 font-mono">
          {block.toolName ?? "tool_call"}
        </span>
        <span className="text-zinc-500 ml-auto">{block.stageName}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs">
          {block.toolArgs && (
            <pre className="text-zinc-400 font-mono whitespace-pre-wrap mb-2 max-h-40 overflow-y-auto">
              {block.toolArgs}
            </pre>
          )}
          {block.content && (
            <div className="text-zinc-300 whitespace-pre-wrap max-h-60 overflow-y-auto">
              {block.content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultBlock({ block }: { block: MessageBlock }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-zinc-700/30 rounded-md overflow-hidden ml-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1 text-xs bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors text-left"
      >
        <span className="text-zinc-500">{expanded ? "▾" : "▸"}</span>
        <span className="text-zinc-400 font-mono">
          ↳ result{block.toolName ? `: ${block.toolName}` : ""}
        </span>
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs text-zinc-400 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
          {block.content}
        </div>
      )}
    </div>
  );
}

// Need useState import for collapsible components
import { useState } from "react";

export function RunConversation({ runId, isRunning }: RunConversationProps) {
  const buffer = useStreamingStore((s) => s.buffers.get(runId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const events = buffer?.events ?? [];
  const blocks = eventsToBlocks(events);

  // Determine if the last block is still streaming
  const lastEvent = events[events.length - 1];
  const isLastStreaming =
    isRunning &&
    lastEvent?.data.eventType === "agent_message" &&
    lastEvent?.data.metadata?.isStreaming;

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [blocks.length, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  if (events.length === 0 && !isRunning) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No conversation output yet
      </div>
    );
  }

  if (events.length === 0 && isRunning) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        <span className="animate-pulse">Waiting for agent output...</span>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-3 px-1 pb-4"
      >
        {blocks.map((block) => {
          const isStreamingBlock =
            isLastStreaming &&
            block === blocks[blocks.length - 1] &&
            block.type === "assistant";

          switch (block.type) {
            case "user":
              return (
                <div
                  key={block.id}
                  className={`rounded-lg px-4 py-3 text-sm ${
                    block.isIntervention
                      ? "bg-amber-950/30 border border-amber-500/20 text-amber-200"
                      : "bg-zinc-800/50 border border-zinc-700/50 text-zinc-300"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-zinc-400">
                      {block.isIntervention ? "💬 Intervention" : "👤 User"}
                    </span>
                    <span className="text-xs text-zinc-600">
                      {block.stageName}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap">{block.content}</div>
                </div>
              );

            case "assistant":
              return (
                <div key={block.id} className="pl-1 py-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-zinc-400">
                      🤖 Assistant
                    </span>
                    <span className="text-xs text-zinc-600">
                      {block.stageName}
                    </span>
                    {isStreamingBlock && (
                      <span className="text-xs text-green-400 animate-pulse">
                        streaming...
                      </span>
                    )}
                  </div>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <AssistantMessage
                      content={block.content}
                      isStreaming={!!isStreamingBlock}
                    />
                  </div>
                </div>
              );

            case "tool_call":
              return <ToolCallBlock key={block.id} block={block} />;

            case "tool_result":
              return <ToolResultBlock key={block.id} block={block} />;

            case "thought":
              return (
                <details
                  key={block.id}
                  className="text-xs text-zinc-500 border border-zinc-800/50 rounded-md"
                >
                  <summary className="px-3 py-1.5 cursor-pointer hover:bg-zinc-800/30 transition-colors">
                    💭 Agent reasoning · {block.stageName}
                  </summary>
                  <div className="px-3 py-2 italic whitespace-pre-wrap">
                    {block.content}
                  </div>
                </details>
              );

            case "session_boundary":
              return (
                <div
                  key={block.id}
                  className="flex items-center gap-3 py-2 text-xs text-zinc-500"
                >
                  <div className="flex-1 h-px bg-zinc-700/50" />
                  <span>
                    Session · {block.stageName} stage
                  </span>
                  <div className="flex-1 h-px bg-zinc-700/50" />
                </div>
              );

            case "system":
              return (
                <div
                  key={block.id}
                  className="text-xs text-zinc-600 italic px-3 py-1"
                >
                  ⚙️ {block.content.slice(0, 200)}
                  {block.content.length > 200 && "..."}
                </div>
              );

            default:
              return null;
          }
        })}
        <div ref={bottomRef} />
      </div>

      {/* "Jump to bottom" button when user has scrolled up */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          className="absolute bottom-4 right-4 px-3 py-1.5 text-xs rounded-full bg-zinc-700 text-zinc-300 hover:bg-zinc-600 shadow-lg transition-colors"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
