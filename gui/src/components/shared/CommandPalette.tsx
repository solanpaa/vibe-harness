import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspaceStore } from "../../stores/workspace";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNewRun: () => void;
}

interface Command {
  id: string;
  label: string;
  group: "Navigation" | "Runs" | "Actions";
  shortcut?: string;
  onSelect: () => void;
}

function fuzzyMatch(query: string, text: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette({ open, onClose, onNewRun }: CommandPaletteProps) {
  const navigate = useNavigate();
  const runs = useWorkspaceStore((s) => s.runs);
  const selectedRunId = useWorkspaceStore((s) => s.selectedRunId);
  const selectRun = useWorkspaceStore((s) => s.selectRun);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build command list
  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-workspace", label: "Go to Workspace", group: "Navigation", shortcut: "⌘1", onSelect: () => { navigate("/"); onClose(); } },
      { id: "nav-projects", label: "Go to Projects", group: "Navigation", shortcut: "⌘2", onSelect: () => { navigate("/projects"); onClose(); } },
      { id: "nav-workflows", label: "Go to Workflows", group: "Navigation", shortcut: "⌘3", onSelect: () => { navigate("/workflows"); onClose(); } },
      { id: "nav-credentials", label: "Go to Credentials", group: "Navigation", shortcut: "⌘4", onSelect: () => { navigate("/credentials"); onClose(); } },
      { id: "nav-settings", label: "Go to Settings", group: "Navigation", shortcut: "⌘5", onSelect: () => { navigate("/settings"); onClose(); } },
    ];

    const runCommands: Command[] = runs.slice(0, 10).map((r) => ({
      id: `run-${r.id}`,
      label: `${r.description || r.id} (${r.status})`,
      group: "Runs" as const,
      onSelect: () => {
        selectRun(r.id);
        navigate("/");
        onClose();
      },
    }));

    const actions: Command[] = [
      { id: "action-new-run", label: "New Run", group: "Actions", shortcut: "⌘N", onSelect: () => { onNewRun(); onClose(); } },
    ];

    // Add cancel action only if a run is selected and running
    if (selectedRunId) {
      const run = runs.find((r) => r.id === selectedRunId);
      if (run && run.status === "running") {
        actions.push({
          id: "action-cancel-run",
          label: `Cancel Run: ${run.description || run.id}`,
          group: "Actions",
          onSelect: () => { onClose(); },
        });
      }
    }

    return [...nav, ...runCommands, ...actions];
  }, [navigate, onClose, onNewRun, runs, selectedRunId, selectRun]);

  // Filter commands by query
  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands.filter((c) => fuzzyMatch(query, c.label));
  }, [commands, query]);

  // Group filtered commands
  const grouped = useMemo(() => {
    const groups: { name: string; items: Command[] }[] = [];
    const order: Command["group"][] = ["Navigation", "Runs", "Actions"];
    for (const g of order) {
      const items = filtered.filter((c) => c.group === g);
      if (items.length > 0) groups.push({ name: g, items });
    }
    return groups;
  }, [filtered]);

  // Flat list for keyboard nav
  const flatItems = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp active index when filtered list changes
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const executeActive = useCallback(() => {
    const item = flatItems[activeIndex];
    if (item) item.onSelect();
  }, [flatItems, activeIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          executeActive();
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [flatItems.length, executeActive, onClose],
  );

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Palette */}
      <div
        className="relative w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center border-b border-zinc-700 px-4 py-3">
          <svg className="w-4 h-4 text-zinc-500 mr-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
          />
          <kbd className="ml-2 text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {flatItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-zinc-500">
              No results found
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.name}>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {group.name}
                </div>
                {group.items.map((item) => {
                  const idx = flatIndex++;
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      className={`w-full flex items-center justify-between px-4 py-2 text-sm cursor-pointer transition-colors ${
                        isActive
                          ? "bg-zinc-700/60 text-zinc-100"
                          : "text-zinc-300 hover:bg-zinc-800/50"
                      }`}
                      onClick={item.onSelect}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <kbd className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
                          {item.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
