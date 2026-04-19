// ---------------------------------------------------------------------------
// Pop-out Window Utility (CDD-gui §9.2, SAD §2.2.2)
//
// Creates new OS windows via Tauri WebviewWindow API.
// Each pop-out gets its own JS context, Zustand stores, and WS connection.
// ---------------------------------------------------------------------------

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Open a route in a new OS window.
 * Uses the Tauri WebviewWindow JS API — no custom Rust command needed.
 */
export function openPopoutWindow(route: string, title: string): void {
  const label = `popout-${Date.now()}`;
  new WebviewWindow(label, {
    url: route,
    title,
    width: 1024,
    height: 768,
    minWidth: 600,
    minHeight: 400,
  });
}

/** Check if this window is a pop-out (route starts with /run/). */
export function isPopoutWindow(): boolean {
  return window.location.pathname.startsWith('/run/');
}
