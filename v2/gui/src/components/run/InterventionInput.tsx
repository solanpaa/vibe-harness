import { useState, useCallback } from "react";
import { useDaemonStore } from "../../stores/daemon";

interface InterventionInputProps {
  runId: string;
  disabled: boolean;
}

export function InterventionInput({ runId, disabled }: InterventionInputProps) {
  const { client } = useDaemonStore();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!client || !message.trim() || sending) return;

    setSending(true);
    try {
      await client.sendIntervention(runId, message.trim());
      setMessage("");
    } catch (err) {
      console.error("Failed to send intervention:", err);
    } finally {
      setSending(false);
    }
  }, [client, runId, message, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex items-center gap-2 p-3 border-t border-zinc-700 bg-zinc-900/50">
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          disabled
            ? "Run is not actively executing"
            : "Send a message to the agent..."
        }
        disabled={disabled || sending}
        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
      />
      <button
        onClick={handleSend}
        disabled={disabled || sending || !message.trim()}
        className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {sending ? "Sending..." : "Send"}
      </button>
    </div>
  );
}
