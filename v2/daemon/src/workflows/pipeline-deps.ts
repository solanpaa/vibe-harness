// ---------------------------------------------------------------------------
// Pipeline Deps Holder
//
// Uses globalThis to share state between the main process and the
// workflow runtime (which may have separate module instances due to
// the "use workflow" bundling).
// ---------------------------------------------------------------------------

import type { PipelineDeps } from './pipeline.js';

const DEPS_KEY = '__vibe_pipeline_deps__';

export function setPipelineDeps(deps: PipelineDeps): void {
  (globalThis as any)[DEPS_KEY] = deps;
}

export function resolvePipelineDeps(): PipelineDeps {
  const deps = (globalThis as any)[DEPS_KEY];
  if (!deps) {
    throw new Error('Pipeline deps not initialized. Call setPipelineDeps() at startup.');
  }
  return deps;
}
