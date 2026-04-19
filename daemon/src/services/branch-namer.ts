// ---------------------------------------------------------------------------
// Branch Namer (CDD §9)
//
// Generates LLM-based branch names from descriptions, sanitizes to valid
// git ref format, and deduplicates against existing branches.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';

// ── Interface ────────────────────────────────────────────────────────

export interface BranchNamer {
  generate(
    description: string,
    existingBranches: string[],
    options?: { prefix?: string; shortId?: string },
  ): Promise<string>;

  sanitize(name: string): string;

  deduplicate(name: string, existingBranches: string[]): string;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createBranchNamer(deps: {
  logger: Logger;
  /** Optional LLM call. When absent, falls back to slugifying the description. */
  llmCall?: (prompt: string) => Promise<string>;
}): BranchNamer {
  const { logger, llmCall } = deps;

  function sanitize(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9.\-/]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/\/{2,}/g, '/')
      .replace(/^[-./]+|[-./]+$/g, '')
      .slice(0, 60);
  }

  function deduplicate(name: string, existingBranches: string[]): string {
    const branchSet = new Set(existingBranches);
    if (!branchSet.has(name)) return name;

    let suffix = 2;
    while (branchSet.has(`${name}-${suffix}`)) {
      suffix++;
    }
    return `${name}-${suffix}`;
  }

  /** Simple slugify fallback: first 50 chars of description → branch-safe slug. */
  function slugify(description: string): string {
    return sanitize(description.slice(0, 50));
  }

  async function generate(
    description: string,
    existingBranches: string[],
    options?: { prefix?: string; shortId?: string },
  ): Promise<string> {
    const prefix = options?.prefix ?? 'vibe-harness';
    const shortId = options?.shortId ?? crypto.randomUUID().slice(0, 8);
    const fallback = `${prefix}/run-${shortId}`;

    // Try LLM-based generation if available
    if (llmCall) {
      try {
        const prompt = [
          'Generate a short git branch name (2-5 words, hyphen-separated) for this task:',
          '',
          description,
          '',
          'Rules:',
          '- Use lowercase letters, numbers, and hyphens only',
          '- No more than 40 characters',
          '- Be descriptive but concise',
          '- Do not include any prefix',
          '',
          'Respond with ONLY the branch name, nothing else.',
        ].join('\n');

        const raw = await llmCall(prompt);
        const cleaned = raw.trim().split('\n')[0].trim();

        if (!cleaned || cleaned.length < 3) {
          logger.warn({ description }, 'LLM returned empty/short branch name, using fallback');
          return deduplicate(fallback, existingBranches);
        }

        const sanitized = sanitize(cleaned);
        if (!sanitized || sanitized.length < 3) {
          return deduplicate(fallback, existingBranches);
        }

        return deduplicate(sanitized, existingBranches);
      } catch (err) {
        logger.warn({ err, description }, 'LLM branch name generation failed, using fallback');
      }
    }

    // Fallback: slugify description
    const slug = slugify(description);
    if (slug && slug.length >= 3) {
      return deduplicate(slug, existingBranches);
    }

    return deduplicate(fallback, existingBranches);
  }

  return { generate, sanitize, deduplicate };
}
