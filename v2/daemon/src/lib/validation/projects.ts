// daemon/src/lib/validation/projects.ts — CDD-schema §3.2

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared.js';

export const createProjectSchema = z.object({
  name: nonEmptyString.max(200),
  localPath: nonEmptyString.max(1024),
  description: z.string().max(2000).optional(),
  defaultCredentialSetId: uuidSchema.optional(),
});

export const updateProjectSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  description: z.string().max(2000).optional(),
  defaultCredentialSetId: uuidSchema.nullable().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
