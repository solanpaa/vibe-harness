// Thin wrappers around @tauri-apps/plugin-dialog for picking host files / dirs.
// Falls back to throwing when not running inside Tauri (e.g. dev browser preview).

import { open } from "@tauri-apps/plugin-dialog";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function pickHostFile(opts?: { title?: string }): Promise<string | null> {
  if (!isTauri()) {
    throw new Error("Native file picker requires the Tauri runtime");
  }
  const selected = await open({
    title: opts?.title ?? "Select a file",
    multiple: false,
    directory: false,
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickHostDir(opts?: { title?: string }): Promise<string | null> {
  if (!isTauri()) {
    throw new Error("Native directory picker requires the Tauri runtime");
  }
  const selected = await open({
    title: opts?.title ?? "Select a directory",
    multiple: false,
    directory: true,
  });
  return typeof selected === "string" ? selected : null;
}

export function nativePickerAvailable(): boolean {
  return isTauri();
}
