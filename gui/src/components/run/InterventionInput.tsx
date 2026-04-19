import { useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";

interface InterventionInputProps {
  runId: string;
  disabled: boolean;
}

export function InterventionInput({ runId, disabled }: InterventionInputProps) {
  const { client } = useDaemonStore();
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string) => {
      if (!client || !text.trim() || sending) return;

      setSending(true);
      try {
        await client.sendIntervention(runId, text.trim());
      } catch (err) {
        console.error("Failed to send intervention:", err);
      } finally {
        setSending(false);
      }
    },
    [client, runId, sending],
  );

  const isDisabled = disabled || sending;

  return (
    <PromptInput
      onSubmit={(msg) => handleSend(msg.text)}
      className="border-t border-border pt-3 px-3 pb-3"
    >
      <PromptInputTextarea
        placeholder={
          disabled
            ? "Run is not actively executing"
            : "Send a message to the agent..."
        }
        disabled={isDisabled}
      />
      <PromptInputSubmit
        status={isDisabled ? "streaming" : "ready"}
      />
    </PromptInput>
  );
}
