import { z } from 'zod';

import { reviewRunStatusSchema } from './hosted.js';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const timestampSchema = z.string().datetime({ offset: true });

export const WALKZ_MCP_GRANT_MAX_TTL_MS = 15 * 60 * 1_000;

export const walkzMcpCapabilitySchema = z.enum(['read', 'prove', 'fix']);

export const walkzMcpGrantSchema = z.object({
  grantId: z.uuid(),
  audience: z.literal('walkz-mcp'),
  subjectId: z.uuid(),
  repositoryId: z.uuid(),
  capabilities: z.array(walkzMcpCapabilitySchema).min(1).max(3),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict().superRefine((grant, context) => {
  if (new Set(grant.capabilities).size !== grant.capabilities.length) {
    context.addIssue({
      code: 'custom',
      message: 'MCP capabilities must be unique.',
      path: ['capabilities'],
    });
  }
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (expiresAt <= issuedAt) {
    context.addIssue({
      code: 'custom',
      message: 'MCP grant expiry must follow issuance.',
      path: ['expiresAt'],
    });
  } else if (expiresAt - issuedAt > WALKZ_MCP_GRANT_MAX_TTL_MS) {
    context.addIssue({
      code: 'custom',
      message: 'MCP grant lifetime must not exceed 15 minutes.',
      path: ['expiresAt'],
    });
  }
});

export const walkzMcpReadInputSchema = z.object({
  reviewRunId: z.uuid(),
}).strict();

const actionInputShape = {
  requestId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  expectedHeadSha: sha1Schema,
};

export const walkzMcpProveInputSchema = z.object(actionInputShape).strict();
export const walkzMcpFixInputSchema = z.object(actionInputShape).strict();

const findingSchema = z.object({
  findingId: z.uuid(),
  evidenceLevel: z.enum(['VERIFIED', 'SUPPORTED', 'UNVERIFIED']),
  lifecycleStatus: z.enum([
    'proposed',
    'challenged',
    'proving',
    'verified',
    'supported',
    'unverified',
    'dismissed',
    'fixed',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  summary: z.string().max(2_000),
  path: z.string().max(1_024).nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
}).strict();

export const walkzMcpReadOutputSchema = z.object({
  reviewRunId: z.uuid(),
  headSha: sha1Schema,
  status: reviewRunStatusSchema,
  verdict: z.enum(['SHIP', 'FIX', 'HUMAN', 'INCONCLUSIVE', 'ERROR']).nullable(),
  summary: z.string().max(2_000).nullable(),
  findings: z.array(findingSchema).max(50),
}).strict();

export const walkzMcpProveOutputSchema = z.object({
  operationId: z.uuid(),
  requestId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  headSha: sha1Schema,
  status: z.enum(['queued', 'already_queued']),
}).strict();

export const walkzMcpFixOutputSchema = z.object({
  proposalId: z.uuid(),
  requestId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  headSha: sha1Schema,
  patchHash: sha256Schema,
  status: z.enum(['awaiting_human', 'already_requested']),
  approvalRequired: z.literal(true),
}).strict();

export type WalkzMcpCapability = z.infer<typeof walkzMcpCapabilitySchema>;
export type WalkzMcpGrant = z.infer<typeof walkzMcpGrantSchema>;
export type WalkzMcpReadInput = z.infer<typeof walkzMcpReadInputSchema>;
export type WalkzMcpProveInput = z.infer<typeof walkzMcpProveInputSchema>;
export type WalkzMcpFixInput = z.infer<typeof walkzMcpFixInputSchema>;
export type WalkzMcpReadOutput = z.infer<typeof walkzMcpReadOutputSchema>;
export type WalkzMcpProveOutput = z.infer<typeof walkzMcpProveOutputSchema>;
export type WalkzMcpFixOutput = z.infer<typeof walkzMcpFixOutputSchema>;
