import { useEffect, useState } from "react";
import { useStreamingStore, resyncFromRest } from "../../stores/streaming";
import { useDaemonStore } from "../../stores/daemon";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
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
        let toolName = data.metadata?.toolName || data.content?.replace(/^Tool call:\s*/i, "") || "tool";
        // Strip worktree paths: "Viewing ...worktrees/run-xxx/file.md" → "Viewing file.md"
        toolName = toolName.replace(/\s+\S*\/([^/\s]+)$/, ' $1');
        blocks.push({
          id: `tool-${blocks.length}`,
          type: "tool_call",
          content: "",
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
        // Merge result into the preceding tool_call block when possible
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === "tool_call") {
          lastBlock.content = data.content;
        } else {
          blocks.push({
            id: `tool-result-${blocks.length}`,
            type: "tool_result",
            content: data.content,
            stageName,
            timestamp: ts,
            toolName: data.metadata?.toolName,
          });
        }
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

export function RunConversation({ runId, isRunning }: RunConversationProps) {
  const buffer = useStreamingStore((s) => s.buffers.get(runId));
  const needsResync = useStreamingStore((s) => s.resyncRequired.has(runId));
  const { client } = useDaemonStore();
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
                eventType: (() => {
                  const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata ?? {});
                  return meta.eventType ?? (m.role === 'user' ? 'agent_message' : 'agent_message');
                })() as any,
                metadata: {
                  ...(typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata ?? {})),
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

  if (events.length === 0 && !isRunning) {
    return (
      <Conversation>
        <ConversationEmptyState
          title="No conversation output yet"
          description="Run a task to see agent output here"
        />
      </Conversation>
    );
  }

  if (events.length === 0 && isRunning) {
    return (
      <Conversation>
        <ConversationEmptyState
          title="Waiting for agent output..."
          description="The agent is starting up"
        />
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent>
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
              return (
                <Tool key={block.id} defaultOpen={false} className="mb-1.5">
                  <ToolHeader
                    type={`tool-${block.toolName ?? "tool"}`}
                    state="output-available"
                  />
                  <ToolContent>
                    {block.toolArgs && (
                      <ToolInput input={JSON.parse(block.toolArgs)} />
                    )}
                    {block.content && (
                      <ToolOutput
                        output={<span className="text-sm whitespace-pre-wrap">{block.content}</span>}
                        errorText={undefined}
                      />
                    )}
                  </ToolContent>
                </Tool>
              );

            case "tool_result":
              // Orphaned tool_result (no preceding tool_call to merge into)
              return (
                <Tool key={block.id} defaultOpen={false} className="mb-1.5">
                  <ToolHeader
                    type={`tool-${block.toolName ?? "result"}`}
                    state="output-available"
                  />
                  <ToolContent>
                    <ToolOutput
                      output={<span className="text-sm whitespace-pre-wrap">{block.content}</span>}
                      errorText={undefined}
                    />
                  </ToolContent>
                </Tool>
              );

            case "thought":
              return (
                <Reasoning
                  key={block.id}
                  isStreaming={isRunning && block === blocks[blocks.length - 1]}
                >
                  <ReasoningTrigger />
                  <ReasoningContent>{block.content}</ReasoningContent>
                </Reasoning>
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
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
