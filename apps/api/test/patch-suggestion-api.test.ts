import type { ModelPatchResponse, ProviderAdapter } from '@walkz/contracts';
import { generatePatchCandidate, WALKZ_PATCH_PROMPT_VERSION } from '@walkz/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPatchSuggestionApi,
  createPatchSuggestionPublisher,
} from '../src/index.js';

const repositoryId = '8aa2dfc8-c97f-454f-b838-cc0cda4a7460';
const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const reviewRunId = 'f931b8c5-f267-4b1b-8cb4-273695d4448e';
const findingId = '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const headFile = {
  path: 'src/value.ts',
  content: 'const fallback = "safe";\nreturn input;\n',
};
const apps: Array<ReturnType<typeof createPatchSuggestionApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function candidate() {
  const patch: ModelPatchResponse = {
    findingId,
    headSha,
    path: headFile.path,
    startLine: 2,
    endLine: 2,
    replacement: 'return input ?? fallback;',
    approvalRequired: true,
  };
  const provider: ProviderAdapter = {
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
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        latencyMs: 1,
        rateLimit: {
          retryAfterMs: null,
          remainingRequests: null,
          remainingTokens: null,
          resetRequests: null,
          resetTokens: null,
        },
      },
      requestId: null,
    }),
  };
  return (await generatePatchCandidate({
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    currentHeadSha: headSha,
    deliveryMode: 'suggestion',
    model: 'mock/patcher',
    maxModelTokens: 16_000,
    finding: {
      path: headFile.path,
      startLine: 2,
      endLine: 2,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      claim: 'Fallback is ignored.',
      failureMechanism: 'Undefined is returned.',
    },
    headFile,
  }, { provider })).candidate;
}

function approvedProposal(patchHash: string, reference: string | null = null) {
  const decidedAt = new Date('2026-09-11T00:01:00.000Z');
  return {
    id: proposalId,
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    patchHash,
    deliveryMode: 'suggestion' as const,
    approvalStatus: 'approved' as const,
    githubReference: reference === null
      ? null
      : { kind: 'review_comment' as const, value: reference },
    decidedByUserId: actorUserId,
    decidedAt,
    staleAt: null,
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: decidedAt,
  };
}

describe('patch suggestion publication API', () => {
  it('publishes transient approved content and persists only its GitHub reference', async () => {
    const selected = await candidate();
    const proposal = {
      ...approvedProposal(selected.patchHash),
      approvalStatus: 'pending' as const,
      decidedByUserId: null,
      decidedAt: null,
    };
    const prepare = vi.fn().mockResolvedValue({
      outcome: 'ready',
      target: {
        proposal,
        installationId: '1234',
        owner: 'octocat',
        repository: 'walkz',
        pullRequestNumber: 7,
      },
    });
    const reference = 'https://github.com/octocat/walkz/pull/7#discussion_r321';
    const record = vi.fn().mockResolvedValue({
      outcome: 'applied',
      target: {
        proposal: approvedProposal(selected.patchHash, reference),
        installationId: '1234',
        owner: 'octocat',
        repository: 'walkz',
        pullRequestNumber: 7,
      },
    });
    const loadHeadFile = vi.fn().mockResolvedValue({
      currentHeadSha: headSha,
      ...headFile,
    });
    const publish = vi.fn().mockResolvedValue({
      commentId: '321',
      htmlUrl: reference,
      created: true,
    });
    const release = vi.fn().mockResolvedValue(false);
    const publisher = createPatchSuggestionPublisher(
      { prepare, record, release },
      { forInstallation: vi.fn().mockResolvedValue({ loadHeadFile, publish }) },
    );

    await expect(publisher.publish({
      repositoryId,
      actorUserId,
      proposalId,
      candidate: selected,
    })).resolves.toEqual({ outcome: 'applied', reference, created: true });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: selected.patchHash,
      expectedHeadSha: headSha,
      publicationLeaseOwner: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      publicationLeaseMs: 120_000,
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      proposalId,
      headSha,
      patchHash: selected.patchHash,
      replacement: selected.replacement,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: selected.patchHash,
      expectedHeadSha: headSha,
      githubReferenceValue: reference,
      publicationLeaseOwner: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    }));
    expect(release).toHaveBeenCalledWith({
      proposalId,
      publicationLeaseOwner: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    expect(record.mock.calls[0]?.[0]).not.toHaveProperty('replacement');
  });

  it('does not call GitHub when the reference is already durable', async () => {
    const selected = await candidate();
    const reference = 'https://github.com/octocat/walkz/pull/7#discussion_r321';
    const forInstallation = vi.fn();
    const publisher = createPatchSuggestionPublisher(
      {
        prepare: vi.fn().mockResolvedValue({
          outcome: 'published',
          target: {
            proposal: approvedProposal(selected.patchHash, reference),
            installationId: '1234',
            owner: 'octocat',
            repository: 'walkz',
            pullRequestNumber: 7,
          },
        }),
        record: vi.fn(),
        release: vi.fn(),
      },
      { forInstallation },
    );

    await expect(publisher.publish({
      repositoryId,
      actorUserId,
      proposalId,
      candidate: selected,
    })).resolves.toEqual({ outcome: 'published', reference, created: false });
    expect(forInstallation).not.toHaveBeenCalled();
  });

  it('releases its lease when GitHub fails before publication', async () => {
    const selected = await candidate();
    const prepare = vi.fn().mockResolvedValue({
      outcome: 'ready',
      target: {
        proposal: approvedProposal(selected.patchHash),
        installationId: '1234',
        owner: 'octocat',
        repository: 'walkz',
        pullRequestNumber: 7,
      },
    });
    const record = vi.fn();
    const release = vi.fn().mockResolvedValue(true);
    const publisher = createPatchSuggestionPublisher(
      { prepare, record, release },
      {
        forInstallation: vi.fn().mockResolvedValue({
          loadHeadFile: vi.fn().mockRejectedValue(new Error('GitHub unavailable')),
          publish: vi.fn(),
        }),
      },
    );

    await expect(publisher.publish({
      repositoryId,
      actorUserId,
      proposalId,
      candidate: selected,
    })).rejects.toThrow('GitHub unavailable');
    expect(record).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    const leaseOwner = prepare.mock.calls[0]?.[0].publicationLeaseOwner;
    expect(release).toHaveBeenCalledWith({ proposalId, publicationLeaseOwner: leaseOwner });
  });

  it('authenticates before parsing private patch content and maps stale proposals', async () => {
    const selected = await candidate();
    const publish = vi.fn().mockResolvedValue({
      outcome: 'stale',
      reference: null,
      created: false,
    });
    const authenticator = { authenticate: vi.fn().mockResolvedValue(null) };
    const app = createPatchSuggestionApi({
      authenticator,
      publisher: { publish },
    });
    apps.push(app);
    const url = `/api/repositories/${repositoryId}/patch-proposals/${proposalId}/publish-suggestion`;

    const unauthenticated = await app.inject({ method: 'POST', url, payload: {} });
    expect(unauthenticated.statusCode).toBe(401);
    expect(publish).not.toHaveBeenCalled();

    authenticator.authenticate.mockResolvedValue({
      userId: actorUserId,
      repositoryIds: [repositoryId],
    });
    const stale = await app.inject({
      method: 'POST',
      url,
      payload: { candidate: selected },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'patch_proposal_stale' });
  });

  it('rejects a hash-tampered candidate as a client error', async () => {
    const selected = await candidate();
    const publisher = createPatchSuggestionPublisher(
      { prepare: vi.fn(), record: vi.fn(), release: vi.fn() },
      { forInstallation: vi.fn() },
    );
    const app = createPatchSuggestionApi({
      authenticator: {
        authenticate: vi.fn().mockResolvedValue({
          userId: actorUserId,
          repositoryIds: [repositoryId],
        }),
      },
      publisher,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/patch-proposals/${proposalId}/publish-suggestion`,
      payload: { candidate: { ...selected, replacement: 'tampered' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_patch_candidate' });
  });
});
