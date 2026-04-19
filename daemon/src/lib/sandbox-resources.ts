// ---------------------------------------------------------------------------
// Resolution of sandbox VM resources (sbx --memory / --cpus) for a run.
//
// Policy:
//   - "Use sbx default"  is signaled to callers as `undefined` (omit flag).
//   - Each row stores nullable values, with sentinel encoding on workflow_runs
//     to express the tri-state (inherit / explicit-default / value).
//
// Row encoding on `workflow_runs`:
//   sandboxMemory: null       → inherit from project default
//                  ""         → explicit override: omit the flag (use sbx default)
//                  <string>   → use this value
//   sandboxCpus:   null       → inherit from project default
//                  -1         → explicit override: omit the flag (use sbx default)
//                  >= 0       → use this value (0 = sbx auto)
//
// Row encoding on `projects`:
//   sandboxMemory: null       → no project default (omit flag)
//                  <string>   → project default
//   sandboxCpus:   null       → no project default (omit flag)
//                  >= 0       → project default
// ---------------------------------------------------------------------------

export interface ResolvedSandboxResources {
  memory: string | undefined;
  cpus: number | undefined;
}

export function resolveSandboxResources(
  project: { sandboxMemory: string | null; sandboxCpus: number | null },
  run: { sandboxMemory: string | null; sandboxCpus: number | null },
): ResolvedSandboxResources {
  let memory: string | undefined;
  if (run.sandboxMemory === null) {
    // inherit from project
    memory = project.sandboxMemory ?? undefined;
  } else if (run.sandboxMemory === '') {
    // explicit override → use sbx default
    memory = undefined;
  } else {
    memory = run.sandboxMemory;
  }

  let cpus: number | undefined;
  if (run.sandboxCpus === null) {
    cpus = project.sandboxCpus ?? undefined;
  } else if (run.sandboxCpus < 0) {
    cpus = undefined;
  } else {
    cpus = run.sandboxCpus;
  }

  return { memory, cpus };
}

/**
 * Map a workflow_runs row (with internal sentinel encoding) into the public
 * API shape, where `sandboxMemory`/`sandboxCpus` are tri-state:
 *   undefined → inherit project default (column was null)
 *   null      → explicit "use sbx default" (column was sentinel "" / -1)
 *   value     → use this value
 *
 * Use this when returning rows to API consumers (GUI, CLI) so they can mirror
 * the same semantics they used when creating the run.
 */
export function serializeRunSandboxFields<T extends { sandboxMemory: string | null; sandboxCpus: number | null }>(
  row: T,
): Omit<T, 'sandboxMemory' | 'sandboxCpus'> & {
  sandboxMemory: string | null | undefined;
  sandboxCpus: number | null | undefined;
} {
  const memory: string | null | undefined =
    row.sandboxMemory === null ? undefined : row.sandboxMemory === '' ? null : row.sandboxMemory;
  const cpus: number | null | undefined =
    row.sandboxCpus === null ? undefined : row.sandboxCpus < 0 ? null : row.sandboxCpus;
  return { ...row, sandboxMemory: memory, sandboxCpus: cpus };
}
