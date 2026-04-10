"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/layout/AppHeader";
import { StatusBar } from "@/components/layout/StatusBar";
import { useIsMobile } from "@/hooks/use-mobile";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 500;

interface WorkspaceLayoutProps {
  feedSlot: React.ReactNode;
  detailSlot: React.ReactNode;
  hasSelection?: boolean;
  onBackToFeed?: () => void;
}

export function WorkspaceLayout({ feedSlot, detailSlot, hasSelection, onBackToFeed }: WorkspaceLayoutProps) {
  const isMobile = useIsMobile();
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, moveEvent.clientX));
      setPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  if (isMobile) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <AppHeader />
        <div className="flex-1 overflow-y-auto">
          {hasSelection ? (
            <div className="flex h-full flex-col">
              <button
                onClick={onBackToFeed}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground border-b bg-card transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to tasks
              </button>
              <div className="flex-1 overflow-y-auto">
                {detailSlot}
              </div>
            </div>
          ) : (
            feedSlot
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <AppHeader />
      <div className="flex flex-1 overflow-hidden">
        <div
          className="shrink-0 overflow-y-auto border-r bg-muted/30"
          style={{ width: panelWidth }}
        >
          {feedSlot}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleMouseDown}
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
        />
        <div className="flex-1 overflow-y-auto bg-muted/20">
          {detailSlot}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
