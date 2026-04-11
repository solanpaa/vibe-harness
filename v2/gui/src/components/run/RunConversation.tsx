import { useEffect, useRef, useState } from "react";
import { useStreamingStore, resyncFromRest } from "../../stores/streaming";
import { useDaemonStore } from "../../stores/daemon";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
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
  let pendingThought: { content: string; stageName: string; timestamp: string } | null = null;

  const flushAssistant = () => {
    if (pendingAssistant && pendingAssistant.content.trim()) {
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

  const flushThought = () => {
    if (pendingThought && pendingThought.content.trim()) {
      blocks.push({
        id: `thought-${blocks.length}`,
        type: "thought",
        content: pendingThought.content,
        stageName: pendingThought.stageName,
        timestamp: pendingThought.timestamp,
      });
      pendingThought = null;
    }
  };

  for (const event of events) {
    const { data, stageName } = event;
    if (!data) continue;
    const ts = (data as any).timestamp ?? (data.metadata as any)?.timestamp ?? new Date().toISOString();

    switch (data.eventType) {
      case "agent_message": {
        flushThought();
        if (data.role === "user") {
          // User prompt (from REST or streaming)
          flushAssistant();
          blocks.push({
            id: `user-${blocks.length}`,
            type: "user",
            content: data.content,
            stageName,
            timestamp: ts,
          });
        } else {
          if (!pendingAssistant) {
            pendingAssistant = { content: "", stageName, timestamp: ts };
          }
          pendingAssistant.content += data.content;
        }
        break;
      }
      case "agent_thought": {
        flushAssistant();
        // Consolidate consecutive thought chunks
        if (!pendingThought) {
          pendingThought = { content: "", stageName, timestamp: ts };
        }
        pendingThought.content += data.content;
        break;
      }
      case "tool_call": {
        flushAssistant();
        flushThought();
        const toolName = data.metadata?.toolName || data.content?.replace(/^Tool call:\s*/i, "") || "tool";
        blocks.push({
          id: `tool-${blocks.length}`,
          type: "tool_call",
          content: data.content,
          stageName,
          timestamp: ts,
          toolName,
          toolArgs: data.metadata?.toolArgs
            ? JSON.stringify(data.metadata.toolArgs, null, 2)
            : undefined,
        });
        break;
      }
      case "tool_result": {
        flushThought();
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
        flushThought();
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
        flushThought();
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
        flushAssistant();
        flushThought();
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
        flushThought();
        break;
      }
    }
  }

  flushThought();
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
  return (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse isAnimating={isStreaming}>
          {content}
        </MessageResponse>
      </MessageContent>
    </Message>
  );
}

function UserMessage({ block }: { block: MessageBlock }) {
  return (
    <Message from="user">
      <MessageContent>
        <MessageResponse>{block.content}</MessageResponse>
      </MessageContent>
    </Message>
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

// useState is imported at the top

export function RunConversation({ runId, isRunning }: RunConversationProps) {
  const buffer = useStreamingStore((s) => s.buffers.get(runId));
  const needsResync = useStreamingStore((s) => s.resyncRequired.has(runId));
  const { client } = useDaemonStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [restMessages, setRestMessages] = useState<RunOutputMessage[]>([]);

  // Trigger REST resync when server signals buffer gap
  useEffect(() => {
    if (needsResync && client) {
      resyncFromRest(runId, client).catch(console.error);
    }
  }, [needsResync, runId, client]);

  // Poll for messages from REST when streaming buffer is empty
  useEffect(() => {
    if (!client) return;
    // If streaming buffer has events, don't need REST
    if (buffer?.events?.length) return;

    let cancelled = false;
    const fetchMessages = () => {
      client.getRunMessages(runId)
        .then((res) => {
          if (!cancelled && res.messages?.length) {
            // Transform DB messages to RunOutputMessage format
            const transformed: RunOutputMessage[] = res.messages.map((m: any, i: number) => ({
              type: 'run_output' as const,
              runId,
              seq: i,
              stageName: m.stageName ?? 'execute',
              round: m.round ?? 1,
              data: {
                role: m.role ?? 'user',
                content: m.content ?? '',
                eventType: m.role === 'user' ? 'agent_message' as const : 'agent_message' as const,
                metadata: {
                  timestamp: m.createdAt,
                  isIntervention: m.isIntervention ?? false,
                },
              },
            }));
            setRestMessages(transformed);
          }
        })
        .catch(() => { /* ignore - messages endpoint may not exist yet */ });
    };

    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [client, runId, buffer?.events?.length]);

  const events = buffer?.events?.length ? buffer.events : restMessages;
  const blocks = eventsToBlocks(events);

  // Determine if the last block is still streaming
  const lastEvent = events[events.length - 1];
  const isLastStreaming =
    isRunning &&
    lastEvent?.data?.eventType === "agent_message" &&
    lastEvent?.data?.metadata?.isStreaming;

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
              return <UserMessage key={block.id} block={block} />;

            case "assistant":
              return (
                <AssistantMessage
                  key={block.id}
                  content={block.content}
                  isStreaming={!!isStreamingBlock}
                />
              );

            case "tool_call":
              return <ToolCallBlock key={block.id} block={block} />;

            case "tool_result":
              return <ToolResultBlock key={block.id} block={block} />;

            case "thought":
              return (
                <details
                  key={block.id}
                  className="text-xs text-muted-foreground border border-border/50 rounded-md"
                >
                  <summary className="px-3 py-1.5 cursor-pointer hover:bg-muted/30 transition-colors">
                    💭 Agent reasoning · {block.stageName}
                  </summary>
                  <div className="px-3 py-2 italic whitespace-pre-wrap text-muted-foreground/70">
                    {block.content}
                  </div>
                </details>
              );

            case "session_boundary":
              return (
                <div
                  key={block.id}
                  className="flex items-center gap-3 py-2 text-xs text-muted-foreground"
                >
                  <div className="flex-1 h-px bg-border/50" />
                  <span>Session · {block.stageName} stage</span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
              );

            case "system":
              return (
                <div
                  key={block.id}
                  className="text-xs text-muted-foreground/60 italic px-3 py-1"
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
