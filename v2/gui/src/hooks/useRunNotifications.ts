import { useRef, useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { sendNotification, isPermissionGranted } from "@tauri-apps/plugin-notification";

/**
 * Watches for run status transitions and sends desktop notifications.
 * Only notifies for: awaiting_review, completed, failed.
 */
export function useRunNotifications() {
  const runs = useWorkspaceStore((s) => s.runs);
  const prevStatuses = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Skip if notifications disabled
    if (localStorage.getItem("vibe-notifications-enabled") !== "true") return;

    const prev = prevStatuses.current;
    const notifications: Array<{ title: string; body: string }> = [];

    for (const run of runs) {
      const oldStatus = prev.get(run.id);
      if (!oldStatus || oldStatus === run.status) continue;

      const name = run.title || run.description?.slice(0, 50) || run.id.slice(0, 8);

      if (run.status === "awaiting_review" && oldStatus !== "awaiting_review") {
        notifications.push({
          title: "Review Ready",
          body: `"${name}" needs your review`,
        });
      } else if (run.status === "completed" && oldStatus !== "completed") {
        notifications.push({
          title: "Run Completed",
          body: `"${name}" finished successfully`,
        });
      } else if (run.status === "failed" && oldStatus !== "failed") {
        notifications.push({
          title: "Run Failed",
          body: `"${name}" encountered an error`,
        });
      }
    }

    // Update tracked statuses
    const next = new Map<string, string>();
    for (const run of runs) {
      next.set(run.id, run.status);
    }
    prevStatuses.current = next;

    // Send notifications (fire-and-forget)
    if (notifications.length > 0) {
      isPermissionGranted().then((granted) => {
        if (!granted) return;
        for (const n of notifications) {
          sendNotification(n);
        }
      }).catch(() => {});
    }
  }, [runs]);
}
