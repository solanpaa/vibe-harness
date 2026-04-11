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
