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
