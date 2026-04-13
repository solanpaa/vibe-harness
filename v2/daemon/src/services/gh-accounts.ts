// ---------------------------------------------------------------------------
// GitHub Account Service
//
// Discovers authenticated GitHub accounts from the `gh` CLI. Provides
// account listing with brief caching, per-account token retrieval, and a
// priority-chain token resolver (explicit account → env vars → active account).
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────

export interface GhAccount {
  username: string;
  hostname: string;
  isActive: boolean;
}

export interface GhAccountService {
  /** List all authenticated gh accounts (cached briefly) */
  listAccounts(): Promise<GhAccount[]>;
  /** Get a token for a specific account username */
  getTokenForAccount(username: string): Promise<string>;
  /** Resolve token using the priority chain: explicit account → fallback to gh auth token (active) → env vars */
  resolveToken(ghAccount?: string | null): Promise<string | undefined>;
}

// ── Helpers ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000;
const EXEC_OPTS = { timeout: 5_000, encoding: 'utf-8' as const };

/**
 * Parse `gh auth status` output into structured account objects.
 *
 * Each account block looks like:
 *   github.com
 *     ✓ Logged in to github.com account <user> (keyring)
 *     - Active account: true
 */
function parseAuthStatus(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let currentHost: string | null = null;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    // Hostname line: no leading whitespace, no bullet/checkmark prefix
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentHost = trimmed;
      continue;
    }

    if (!currentHost) continue;

    // "✓ Logged in to <host> account <username> (<method>)"
    const loginMatch = trimmed.match(
      /Logged in to \S+ account (\S+)/,
    );
    if (loginMatch) {
      accounts.push({
        username: loginMatch[1],
        hostname: currentHost,
        isActive: false, // updated below if active
      });
      continue;
    }

    // "- Active account: true/false"
    const activeMatch = trimmed.match(/Active account:\s*(true|false)/i);
    if (activeMatch && accounts.length > 0) {
      const last = accounts[accounts.length - 1];
      if (last.hostname === currentHost) {
        last.isActive = activeMatch[1].toLowerCase() === 'true';
      }
    }
  }

  return accounts;
}

// ── Factory ───────────────────────────────────────────────────────────

export function createGhAccountService(): GhAccountService {
  let cachedAccounts: GhAccount[] | null = null;
  let cacheExpiry = 0;

  async function listAccounts(): Promise<GhAccount[]> {
    const now = Date.now();
    if (cachedAccounts && now < cacheExpiry) {
      return cachedAccounts;
    }

    try {
      const output = execSync('gh auth status', EXEC_OPTS);
      cachedAccounts = parseAuthStatus(output);
    } catch (err: unknown) {
      // gh auth status exits non-zero but still prints useful info to stderr
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: unknown }).stderr)
          : '';
      const stdout =
        err && typeof err === 'object' && 'stdout' in err
          ? String((err as { stdout: unknown }).stdout)
          : '';
      const combined = stdout + '\n' + stderr;
      cachedAccounts = parseAuthStatus(combined);
    }

    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cachedAccounts;
  }

  async function getTokenForAccount(username: string): Promise<string> {
    const token = execSync(`gh auth token --user ${username}`, EXEC_OPTS).trim();
    if (!token) {
      throw new Error(`No token returned for account "${username}"`);
    }
    return token;
  }

  async function resolveToken(
    ghAccount?: string | null,
  ): Promise<string | undefined> {
    // 1. Explicit account
    if (ghAccount) {
      return getTokenForAccount(ghAccount);
    }

    // 2. Environment variables
    if (process.env.GITHUB_TOKEN) {
      return process.env.GITHUB_TOKEN;
    }
    if (process.env.GH_TOKEN) {
      return process.env.GH_TOKEN;
    }

    // 3. Default active account via gh CLI
    try {
      const token = execSync('gh auth token', EXEC_OPTS).trim();
      if (token) return token;
    } catch {
      // gh not authenticated or not installed – fall through
    }

    return undefined;
  }

  return { listAccounts, getTokenForAccount, resolveToken };
}
