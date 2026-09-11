import { createHash } from 'node:crypto';

import {
  parsePatchProposal,
  patchPathSchema,
  type PatchCandidate,
  type PatchProposal,
} from '@walkz/contracts';
import { z } from 'zod';

import { verifyPatchCandidateIntegrity } from './patch-generation.js';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const headFileSchema = z.object({
  path: patchPathSchema,
  content: z.string().max(512 * 1_024).refine(
    (value) => !value.includes('\0'),
    { message: 'Patch publication does not accept binary file content.' },
  ),
}).strict();

export type PatchPublicationFailureCode =
  | 'invalid_input'
  | 'not_approved'
  | 'stale_head'
  | 'integrity_mismatch'
  | 'unsupported_delivery';

export class PatchPublicationError extends Error {
  readonly code: PatchPublicationFailureCode;

  constructor(
    code: PatchPublicationFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PatchPublicationError';
    this.code = code;
  }
}

export interface PreparedPatchSuggestion {
  proposalId: string;
  reviewRunId: string;
  findingId: string;
  headSha: string;
  patchHash: string;
  path: string;
  startLine: number;
  endLine: number;
  originalHash: string;
  replacement: string;
}

export interface PreparePatchSuggestionInput {
  candidate: unknown;
  proposal: unknown;
  currentHeadSha: unknown;
  headFile: unknown;
}

function normalizedLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseInputs(input: PreparePatchSuggestionInput): {
  candidate: PatchCandidate;
  proposal: PatchProposal;
  currentHeadSha: string;
  headFile: z.infer<typeof headFileSchema>;
} {
  try {
    return {
      candidate: verifyPatchCandidateIntegrity(input.candidate),
      proposal: parsePatchProposal(input.proposal),
      currentHeadSha: sha1Schema.parse(input.currentHeadSha).toLowerCase(),
      headFile: headFileSchema.parse(input.headFile),
    };
  } catch (error) {
    throw new PatchPublicationError(
      'invalid_input',
      'Patch publication input is invalid.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export function prepareApprovedPatchSuggestion(
  input: PreparePatchSuggestionInput,
): PreparedPatchSuggestion {
  const { candidate, proposal, currentHeadSha, headFile } = parseInputs(input);
  if (candidate.deliveryMode !== 'suggestion' || proposal.deliveryMode !== 'suggestion') {
    throw new PatchPublicationError(
      'unsupported_delivery',
      'This publication path accepts GitHub suggestions only.',
    );
  }
  if (proposal.approvalStatus !== 'approved' || proposal.decidedByUserId === null) {
    throw new PatchPublicationError(
      'not_approved',
      'A user must approve the exact patch proposal before publication.',
    );
  }
  if (proposal.staleAt !== null || currentHeadSha !== candidate.headSha.toLowerCase()) {
    throw new PatchPublicationError(
      'stale_head',
      'The pull request head changed before patch publication.',
    );
  }
  if (
    proposal.reviewRunId !== candidate.reviewRunId ||
    proposal.findingId !== candidate.findingId ||
    proposal.baseSha.toLowerCase() !== candidate.baseSha.toLowerCase() ||
    proposal.headSha.toLowerCase() !== candidate.headSha.toLowerCase() ||
    proposal.patchHash.toLowerCase() !== candidate.patchHash.toLowerCase()
  ) {
    throw new PatchPublicationError(
      'integrity_mismatch',
      'The approved proposal does not match the supplied patch candidate.',
    );
  }
  if (headFile.path !== candidate.path) {
    throw new PatchPublicationError(
      'integrity_mismatch',
      'The supplied head file does not match the approved patch path.',
    );
  }

  const lines = normalizedLines(headFile.content);
  if (candidate.startLine > lines.length || candidate.endLine > lines.length) {
    throw new PatchPublicationError(
      'integrity_mismatch',
      'The approved source range is outside the exact head file.',
    );
  }
  const original = lines
    .slice(candidate.startLine - 1, candidate.endLine)
    .join('\n');
  if (sha256(original) !== candidate.originalHash.toLowerCase()) {
    throw new PatchPublicationError(
      'integrity_mismatch',
      'The approved source lines no longer match their recorded hash.',
    );
  }

  return {
    proposalId: proposal.id,
    reviewRunId: candidate.reviewRunId,
    findingId: candidate.findingId,
    headSha: candidate.headSha.toLowerCase(),
    patchHash: candidate.patchHash.toLowerCase(),
    path: candidate.path,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    originalHash: candidate.originalHash.toLowerCase(),
    replacement: candidate.replacement,
  };
}
