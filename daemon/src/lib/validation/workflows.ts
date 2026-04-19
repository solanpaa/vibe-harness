// daemon/src/lib/validation/workflows.ts — CDD-schema §3.4

import { z } from 'zod';
import { nonEmptyString } from './shared.js';

export const workflowStageSchema = z.object({
  name: nonEmptyString.max(200).refine(
    (n) => !n.startsWith('__splitter__:') && n !== '__consolidation__',
    { message: 'Stage name uses a reserved internal prefix' },
  ),
  /**
   * When true, the stage's review screen exposes a Split action that
   * triggers the ad-hoc split sub-pipeline.
   */
  splittable: z.boolean().optional().default(false),
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

// ─── App settings schemas (rubber-duck blockers #1, #10) ───────────────
//
// Used both on settings update (POST) and on read (with safeParse) so a
// corrupted DB row surfaces as a clear error instead of silently passing
// malformed config to the workflow.

/**
 * A post-split stage is the same shape as a normal stage with one extra
 * constraint: it cannot itself be `splittable: true` (no recursive split).
 */
export const postSplitStageSchema = workflowStageSchema.refine(
  (s) => s.splittable !== true,
  { message: 'Post-split stages cannot be splittable (no recursive split)' },
);

export const defaultPostSplitStagesSchema = z.array(postSplitStageSchema).max(20);

export const defaultSplitterPromptTemplateSchema = z.string().min(1).max(20000);

export const updateAppSettingsSchema = z.object({
  defaultSplitterPromptTemplate: defaultSplitterPromptTemplateSchema.optional(),
  defaultPostSplitStages: defaultPostSplitStagesSchema.optional(),
});

export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsSchema>;

