"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";

interface TaskPromptProps {
  prompt: string;
  defaultExpanded?: boolean;
}

export function TaskPrompt({ prompt, defaultExpanded = false }: TaskPromptProps) {
  const [promptExpanded, setPromptExpanded] = useState(defaultExpanded);

  return (
    <div className="shrink-0 border-b bg-card">
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        onClick={() => setPromptExpanded((v) => !v)}
      >
        {promptExpanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Prompt
        {!promptExpanded && (
          <span className="truncate text-muted-foreground/70 font-normal">
            — {prompt.slice(0, 80)}{prompt.length > 80 ? "…" : ""}
          </span>
        )}
      </button>
      {promptExpanded && (
        <div className="px-4 pb-3 border-t bg-muted/20">
          <div className="pt-3">
            <Markdown>{prompt}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
