// daemon/src/lib/validation/credentials.ts — CDD §8

import { z } from 'zod';
import { nonEmptyString, uuidSchema, envVarKeySchema } from './shared.js';

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

export const createCredentialEntrySchema = z
  .object({
    key: nonEmptyString.max(500),
    value: z.string().max(100_000).optional().default(''),
    type: credentialEntryTypeSchema,
    mountPath: z.string().max(1024).optional(),
    command: z.string().max(4096).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'env_var') {
      // env-var names are interpolated into shell scripts (bash -lc 'export …'
      // and /etc/sandbox-persistent.sh). Enforce POSIX identifier rules to
      // prevent shell-injection via the key field.
      const r = envVarKeySchema.safeParse(data.key);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['key'],
          message: r.error.issues[0]?.message ?? 'Invalid environment variable name',
        });
      }
    }
    if (data.type === 'file_mount' || data.type === 'host_dir_mount') {
      if (!data.mountPath || data.mountPath.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mountPath'],
          message: 'mountPath is required for file_mount and host_dir_mount',
        });
      }
      if (!data.value || data.value.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'value (host path) is required for file_mount and host_dir_mount',
        });
      }
    }
    if (data.type === 'command_extract') {
      if (!data.command || data.command.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: 'command is required for command_extract',
        });
      }
    }
  });

export type CreateCredentialSetInput = z.infer<typeof createCredentialSetSchema>;
export type CreateCredentialEntryInput = z.infer<typeof createCredentialEntrySchema>;
