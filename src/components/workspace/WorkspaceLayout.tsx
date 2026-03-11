"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Terminal } from "lucide-react";
import { ConfigMenu } from "./ConfigMenu";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 500;

interface WorkspaceLayoutProps {
  feedSlot: React.ReactNode;
  detailSlot: React.ReactNode;
}

export function WorkspaceLayout({ feedSlot, detailSlot }: WorkspaceLayoutProps) {
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

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b bg-card px-4 shadow-sm">
        <Link href="/" className="flex items-center gap-2 font-bold text-sm">
          <Terminal className="h-5 w-5" />
          Vibe Harness
        </Link>
        <ConfigMenu />
      </header>

      {/* Panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — task feed */}
        <div
          className="shrink-0 overflow-y-auto border-r bg-muted/30"
          style={{ width: panelWidth }}
        >
          {feedSlot}
        </div>

        {/* Resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleMouseDown}
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
        />

        {/* Right panel — detail */}
        <div className="flex-1 overflow-y-auto bg-muted/20">
          {detailSlot}
        </div>
      </div>
    </div>
  );
}
