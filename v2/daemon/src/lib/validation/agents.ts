// daemon/src/lib/validation/agents.ts — CDD-schema §3.3

import { z } from 'zod';
import { nonEmptyString } from './shared.js';

const agentTypeEnum = z.enum(['copilot_cli']);
const outputFormatEnum = z.enum(['acp', 'jsonl', 'text']);

export const createAgentDefinitionSchema = z.object({
  name: nonEmptyString.max(200),
  type: agentTypeEnum,
  commandTemplate: nonEmptyString.max(2000),
  dockerImage: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  supportsStreaming: z.boolean().optional().default(true),
  supportsContinue: z.boolean().optional().default(true),
  supportsIntervention: z.boolean().optional().default(true),
  outputFormat: outputFormatEnum.optional().default('acp'),
});

export const updateAgentDefinitionSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  commandTemplate: nonEmptyString.max(2000).optional(),
  dockerImage: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  supportsStreaming: z.boolean().optional(),
  supportsContinue: z.boolean().optional(),
  supportsIntervention: z.boolean().optional(),
  outputFormat: outputFormatEnum.optional(),
});

export type CreateAgentDefinitionInput = z.infer<typeof createAgentDefinitionSchema>;
export type UpdateAgentDefinitionInput = z.infer<typeof updateAgentDefinitionSchema>;
