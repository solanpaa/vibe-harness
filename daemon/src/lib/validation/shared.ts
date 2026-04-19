// daemon/src/lib/validation/shared.ts — CDD-schema §3.1

import { z } from 'zod';

/**
 * Git ref validator — blocks injection characters.
 * Allows: a-z A-Z 0-9 . _ / -
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-zA-Z0-9._-]([a-zA-Z0-9._\/-]*[a-zA-Z0-9._-])?$/,
    'Invalid git ref: must not start/end with slash, only alphanumerics, dots, underscores, slashes, and hyphens allowed',
  )
  .refine((val) => !val.includes('..'), 'Git ref must not contain ".."')
  .refine((val) => !val.includes('//'), 'Git ref must not contain consecutive slashes');

export const uuidSchema = z.string().uuid();

export const nonEmptyString = z.string().trim().min(1, 'Must not be empty');

/**
 * sbx --memory value, e.g. "1024m", "8g", "32G".
 * Format: positive integer followed by m, M, g, or G (binary units).
 * null is allowed to mean "use sbx default" (caller should distinguish
 * undefined = inherit from project).
 */
export const sandboxMemorySchema = z
  .string()
  .trim()
  .regex(
    /^[1-9]\d*(m|M|g|G)$/,
    'Memory must be a positive integer followed by m, M, g, or G (e.g. "1024m", "8g")',
  )
  .max(16);

/**
 * sbx --cpus value: non-negative integer. 0 = sbx auto.
 */
export const sandboxCpusSchema = z.number().int().min(0).max(256);

/**
 * Environment variable name. POSIX shell identifier rules: must start with
 * a letter or underscore, followed by letters, digits, or underscores.
 *
 * This is enforced for both safety (env-var names are interpolated raw into
 * `export NAME=...` lines built for `bash -lc` and `/etc/sandbox-persistent.sh`,
 * so a malicious key like `FOO; rm -rf /; #` would otherwise yield shell
 * injection) and correctness (POSIX `export` rejects non-identifier names).
 */
export const envVarKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Environment variable name must match [A-Za-z_][A-Za-z0-9_]* (POSIX shell identifier)',
  );

/**
 * Validate that a string is a safe POSIX env-var identifier.
 * Throws if invalid. Used as a defence-in-depth guard inside sandbox/acp-client
 * builders that interpolate keys into shell scripts.
 */
export function assertValidEnvVarKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `Refusing to build shell command with unsafe env-var name: ${JSON.stringify(key)}. ` +
        `Names must match [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
}
