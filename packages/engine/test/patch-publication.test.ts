import type { ModelPatchResponse, ProviderAdapter } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  generatePatchCandidate,
  prepareApprovedPatchSuggestion,
  WALKZ_PATCH_PROMPT_VERSION,
} from '../src/index.js';

const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const reviewRunId = 'f931b8c5-f267-4b1b-8cb4-273695d4448e';
const findingId = '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68';
const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const headFile = {
  path: 'src/value.ts',
  content: [
    'export function value(input: string | undefined) {',
    '  const fallback = "safe";',
    '  return input;',
    '}',
    '',
  ].join('\n'),
};

function provider(): ProviderAdapter {
  const patch: ModelPatchResponse = {
    findingId,
    headSha,
    path: headFile.path,
    startLine: 3,
    endLine: 3,
    replacement: '  return input ?? fallback;',
    approvalRequired: true,
  };
  return {
    name: 'mock',
    listModels: vi.fn().mockResolvedValue([]),
    validateAccess: vi.fn().mockResolvedValue({
      provider: 'mock',
      selectedModel: 'mock/patcher',
      models: [{
        id: 'mock/patcher',
        active: true,
        contextWindow: 32_768,
        maxCompletionTokens: 4_096,
        supportsStrictStructuredOutput: true,
      }],
      privacyNotice: 'Local test provider.',
      dataControlsUrl: null,
    }),
    requestStructuredReview: vi.fn().mockRejectedValue(new Error('unused')),
    requestStructuredPatch: vi.fn().mockResolvedValue({
      provider: 'mock',
      model: 'mock/patcher',
      promptVersion: WALKZ_PATCH_PROMPT_VERSION,
      schemaVersion: 'walkz-patch-v1',
      patch,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        latencyMs: 5,
        rateLimit: {
          retryAfterMs: null,
          remainingRequests: null,
          remainingTokens: null,
          resetRequests: null,
          resetTokens: null,
        },
      },
      requestId: 'patch-request-1',
    }),
  };
}

async function fixture(deliveryMode: 'suggestion' | 'fix_branch' = 'suggestion') {
  const generated = await generatePatchCandidate({
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    currentHeadSha: headSha,
    deliveryMode,
    model: 'mock/patcher',
    maxModelTokens: 16_000,
    finding: {
      path: headFile.path,
      startLine: 3,
      endLine: 3,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      claim: 'The function ignores the fallback value.',
      failureMechanism: 'Undefined is returned instead of the fallback.',
    },
    headFile,
  }, { provider: provider() });
  const decidedAt = new Date('2026-09-11T00:01:00.000Z');
  return {
    candidate: generated.candidate,
    proposal: {
      id: proposalId,
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash: generated.candidate.patchHash,
      deliveryMode,
      approvalStatus: 'approved',
      githubReference: null,
      decidedByUserId: actorUserId,
      decidedAt,
      staleAt: null,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      updatedAt: decidedAt,
    },
  };
}

describe('approved patch publication preparation', () => {
  it('rechecks approval, exact revisions, candidate hash, and source lines', async () => {
    const { candidate, proposal } = await fixture();

    expect(prepareApprovedPatchSuggestion({
      candidate,
      proposal,
      currentHeadSha: headSha,
      headFile,
    })).toEqual({
      proposalId,
      reviewRunId,
      findingId,
      headSha,
      patchHash: candidate.patchHash,
      path: headFile.path,
      startLine: 3,
      endLine: 3,
      originalHash: candidate.originalHash,
      replacement: '  return input ?? fallback;',
    });
  });

  it('rejects pending approval and a newer pull request head', async () => {
    const { candidate, proposal } = await fixture();

    expect(() => prepareApprovedPatchSuggestion({
      candidate,
      proposal: {
        ...proposal,
        approvalStatus: 'pending',
        decidedByUserId: null,
        decidedAt: null,
      },
      currentHeadSha: headSha,
      headFile,
    })).toThrow('approve');
    expect(() => prepareApprovedPatchSuggestion({
      candidate,
      proposal,
      currentHeadSha: 'c'.repeat(40),
      headFile,
    })).toThrow('head changed');
  });

  it('rejects tampered candidates, proposals, paths, and source lines', async () => {
    const { candidate, proposal } = await fixture();
    const inputs = [
      { candidate: { ...candidate, replacement: 'return unsafe;' }, proposal, headFile },
      { candidate, proposal: { ...proposal, patchHash: 'd'.repeat(64) }, headFile },
      { candidate, proposal, headFile: { ...headFile, path: 'src/other.ts' } },
      { candidate, proposal, headFile: { ...headFile, content: headFile.content.replace('return input;', 'return fallback;') } },
    ];

    for (const input of inputs) {
      expect(() => prepareApprovedPatchSuggestion({
        ...input,
        currentHeadSha: headSha,
      })).toThrow();
    }
  });

  it('keeps fix-branch delivery outside the suggestion permission path', async () => {
    const { candidate, proposal } = await fixture('fix_branch');

    expect(() => prepareApprovedPatchSuggestion({
      candidate,
      proposal,
      currentHeadSha: headSha,
      headFile,
    })).toThrow();
  });
});
