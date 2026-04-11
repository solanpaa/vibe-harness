import { useEffect } from "react";

interface ShortcutMap {
  [key: string]: () => void;
}

/**
 * Register global keyboard shortcuts.
 * Keys use format: "mod+k" (mod = Cmd on Mac, Ctrl otherwise)
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
        e.preventDefault();
        action();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}
