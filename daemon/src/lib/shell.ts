// ---------------------------------------------------------------------------
// Shell execution helper (CDD §2.2)
//
// All services use execCommand() instead of exec() to prevent injection.
// Arguments are passed as an explicit array — never concatenated into a string.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
}

/**
 * Execute a command with explicit argument array (no shell interpolation).
 *
 * @param command - Executable name (e.g., 'git', 'docker')
 * @param args - Argument array (never concatenated into a string)
 * @param options - cwd, env overrides, timeout
 */
export async function execCommand(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeout ?? 60_000,
      maxBuffer: 50 * 1024 * 1024, // 50 MB for large diffs
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; code?: number };
    if (e.killed) {
      throw new CommandTimeoutError(command, args, options.timeout ?? 60_000);
    }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

export class CommandTimeoutError extends Error {
  constructor(command: string, args: string[], timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`,
    );
    this.name = 'CommandTimeoutError';
  }
}
