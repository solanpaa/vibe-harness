// daemon/src/lib/validation/credentials.ts — CDD §8

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared.js';

export const credentialEntryTypeSchema = z.enum([
  'env_var',
  'file_mount',
  'docker_login',
  'host_dir_mount',
  'command_extract',
]);

export const createCredentialSetSchema = z.object({
  name: nonEmptyString.max(200),
  description: z.string().max(2000).optional(),
  projectId: uuidSchema.optional(),
});

export const createCredentialEntrySchema = z.object({
  key: nonEmptyString.max(500),
  value: z.string().max(100_000).optional().default(''),
  type: credentialEntryTypeSchema,
  mountPath: z.string().max(1024).optional(),
  command: z.string().max(4096).optional(),
});

export type CreateCredentialSetInput = z.infer<typeof createCredentialSetSchema>;
export type CreateCredentialEntryInput = z.infer<typeof createCredentialEntrySchema>;
