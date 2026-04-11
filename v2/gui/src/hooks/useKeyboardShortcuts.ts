import { useEffect } from "react";

interface ShortcutMap {
  [key: string]: () => void;
}

/**
 * Returns true if the event target is an input, textarea, or contenteditable
 * element where single-key shortcuts (j/k/Enter/Escape) should be suppressed.
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((e.target as HTMLElement)?.isContentEditable) return true;
  return false;
}

/**
 * Register global keyboard shortcuts.
 * Keys use format: "mod+k" (mod = Cmd on Mac, Ctrl otherwise).
 * Plain keys like "j", "k", "enter", "escape" are only fired
 * when no input/textarea is focused.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");

    function handler(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const parts: string[] = [];
      if (mod) parts.push("mod");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      parts.push(e.key.toLowerCase());

      const combo = parts.join("+");
      const action = shortcuts[combo];
      if (action) {
        // For plain keys (no modifier), skip if user is typing in an input
        const hasModifier = mod || e.shiftKey || e.altKey;
        if (!hasModifier && isEditableTarget(e)) return;

        e.preventDefault();
        action();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}
