// daemon/src/lib/validation/projects.ts — CDD-schema §3.2

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared.js';

export const createProjectSchema = z.object({
  name: nonEmptyString.max(100),
  localPath: nonEmptyString.max(1024),
  description: z.string().max(500).nullable().optional(),
  defaultCredentialSetId: uuidSchema.nullable().optional(),
  ghAccount: z.string().max(100).nullable().optional(),
});

export const updateProjectSchema = z.object({
  name: nonEmptyString.max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  defaultCredentialSetId: uuidSchema.nullable().optional(),
  ghAccount: z.string().max(100).nullable().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
