// daemon/src/lib/validation/workflows.ts — CDD-schema §3.4

import { z } from 'zod';
import { nonEmptyString } from './shared.js';

const stageTypeEnum = z.enum(['standard', 'split']);

export const workflowStageSchema = z.object({
  name: nonEmptyString.max(200),
  type: stageTypeEnum,
  promptTemplate: nonEmptyString.max(10000),
  reviewRequired: z.boolean().default(true),
  autoAdvance: z.boolean().default(false),
  freshSession: z.boolean().default(false),
  model: z.string().max(100).optional(),
  isFinal: z.boolean().optional(),
}).refine(data => !(data.reviewRequired && data.autoAdvance), {
  message: 'reviewRequired and autoAdvance are mutually exclusive',
});

export const createWorkflowTemplateSchema = z.object({
  name: nonEmptyString.max(200),
  description: z.string().max(2000).optional(),
  stages: z.array(workflowStageSchema).min(1, 'At least one stage is required').max(20),
});

// PUT is full-replace: reuse createWorkflowTemplateSchema (all fields required)
export const updateWorkflowTemplateSchema = createWorkflowTemplateSchema;

export type CreateWorkflowTemplateInput = z.infer<typeof createWorkflowTemplateSchema>;
export type UpdateWorkflowTemplateInput = z.infer<typeof updateWorkflowTemplateSchema>;
