/** Selection state for the workspace feed and detail panel. */
export type Selection =
  | { kind: "task"; taskId: string }
  | { kind: "review"; reviewId: string; taskId: string };
