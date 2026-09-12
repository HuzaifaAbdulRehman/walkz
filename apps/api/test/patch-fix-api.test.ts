import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import {
  createDefaultWalkzConfig,
  type ProviderAdapter,
} from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  digestProofCommand,
  WALKZ_PATCH_PROMPT_VERSION,
} from '@walkz/engine';
import type { VerifiedPatchFixSource } from '@walkz/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPatchFixRoutes } from '../src/index.js';

const repositoryId = '99516fcb-ec21-4a50-8936-d585e77ca154';
const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const userId = '79f36b7d-919f-480f-931b-cf62ce0141d9';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const proofImage = `node@sha256:${'c'.repeat(64)}`;
const command = { executable: 'npm', args: ['test'], cwd: '.' };
const apps: ReturnType<typeof Fastify>[] = [];

function provider(): ProviderAdapter {
  return {
    name: 'groq',
    listModels: vi.fn().mockResolvedValue([]),
    validateAccess: vi.fn().mockResolvedValue({
      provider: 'groq',
      selectedModel: 'model',
      models: [{
        id: 'model', active: true, contextWindow: 32_768,
        maxCompletionTokens: 4_096, supportsStrictStructuredOutput: true,
      }],
      privacyNotice: 'Test provider.',
      dataControlsUrl: null,
    }),
    requestStructuredReview: vi.fn().mockRejectedValue(new Error('unused')),
    requestStructuredPatch: vi.fn().mockResolvedValue({
      provider: 'groq',
      model: 'model',
      promptVersion: WALKZ_PATCH_PROMPT_VERSION,
      schemaVersion: 'walkz-patch-v1',
      patch: {
        findingId,
        headSha,
        path: 'src/value.ts',
        startLine: 3,
        endLine: 3,
        replacement: '  return input ?? fallback;',
        approvalRequired: true,
      },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        latencyMs: 1,
        rateLimit: {
          retryAfterMs: null, remainingRequests: null, remainingTokens: null,
          resetRequests: null, resetTokens: null,
        },
      },
      requestId: 'request-1',
    }),
  };
}

function source(): VerifiedPatchFixSource {
  const config = {
    ...createDefaultWalkzConfig([{
      id: 'test', ...command, required: true,
    }]),
    commandApprovalPolicy: 'trusted_config' as const,
    provider: { name: 'groq' as const, model: 'model' },
  };
  const commandDigest = digestProofCommand(command);
  const binding = bindPatchProofToRepositoryCommand({
    reviewRunId,
    findingFingerprint: 'd'.repeat(64),
    baseSha,
    headSha,
    commandDigest,
    containerImage: proofImage,
    config,
  });
  return {
    repositoryId,
    installationId: '1234',
    owner: 'owner',
    repository: 'repo',
    pullRequestNumber: 27,
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    config,
    provider: 'groq',
    model: 'model',
    finding: {
      fingerprint: 'd'.repeat(64),
      category: 'correctness',
      severity: 'high',
      file: 'src/value.ts',
      line: 3,
      endLine: 3,
      claim: 'The function ignores the fallback value.',
      failureMechanism: 'Undefined is returned instead of the fallback.',
      suggestedProof: 'Run npm test on base and head.',
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      advisoryConfidence: 0.99,
      evidence: [],
      dismissal: null,
      fix: null,
    },
    proof: {
      planDigest: binding.planDigest,
      commandDigest,
      baseOutcome: 'passed',
      headOutcome: 'failed',
      baseExitCode: 0,
      headExitCode: 1,
      durationMs: 20,
      sanitizedSummary: 'Base passed; head failed.',
      artifactHashes: [],
      recordedAt: new Date('2026-09-11T10:00:00.000Z'),
    },
  };
}

function setup(identity: object | null = { userId, repositoryIds: [repositoryId] }) {
  const selectedSource = source();
  const store = {
    loadSource: vi.fn().mockResolvedValue(selectedSource),
    loadCredential: vi.fn().mockResolvedValue('secret'),
    create: vi.fn().mockImplementation(async (input) => {
      const now = new Date('2026-09-11T10:01:00.000Z');
      return {
        created: true,
        proposal: {
          id: proposalId,
          ...input.proposal,
          approvalStatus: 'pending',
          githubReference: null,
          decidedByUserId: null,
          decidedAt: null,
          staleAt: null,
          createdAt: now,
          updatedAt: now,
        },
        job: {
          proposalId,
          provider: input.provider,
          model: input.model,
          promptVersion: input.promptVersion,
          proofPlanDigest: input.proofPlanDigest,
          proofCommandDigest: input.proofCommandDigest,
          status: 'awaiting_approval',
          attempt: 0,
          failureCode: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      };
    }),
    decide: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  };
  const github = {
    forInstallation: vi.fn().mockResolvedValue({
      loadHeadFile: vi.fn().mockResolvedValue({
        currentHeadSha: headSha,
        path: 'src/value.ts',
        content: [
          'export function value(input: string | undefined) {',
          '  const fallback = "safe";',
          '  return input;',
          '}',
          '',
        ].join('\n'),
      }),
      publish: vi.fn(),
    }),
  };
  const app = Fastify({ logger: false });
  registerPatchFixRoutes(app, {
    authenticator: { authenticate: vi.fn().mockResolvedValue(identity) },
    store,
    github,
    proofImage,
    createProvider: () => provider(),
  });
  apps.push(app);
  return { app, store, github };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('hosted patch fix API', () => {
  it('returns a transient candidate and stores only its hash binding', async () => {
    const { app, store } = setup();

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/reviews/${reviewRunId}/findings/${findingId}/patch-proposals`,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      created: true,
      candidate: { replacement: '  return input ?? fallback;' },
      proposal: { id: proposalId, approvalStatus: 'pending' },
      job: { status: 'awaiting_approval' },
    });
    const stored = store.create.mock.calls[0]?.[0];
    expect(stored.proposal.patchHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain('return input ?? fallback');
  });

  it('authenticates before parsing an approval body', async () => {
    const { app, store } = setup(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/patch-proposals/${proposalId}/decision`,
      payload: { candidate: { replacement: 'private source' } },
    });

    expect(response.statusCode).toBe(401);
    expect(store.decide).not.toHaveBeenCalled();
  });

  it('fails closed when the verified proof binding changes', async () => {
    const { app, store, github } = setup();
    const changed = source();
    changed.proof.planDigest = 'f'.repeat(64);
    store.loadSource.mockResolvedValue(changed);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/reviews/${reviewRunId}/findings/${findingId}/patch-proposals`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'proof_binding_invalid' });
    expect(github.forInstallation).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it('requires the repository provider credential before loading the head file', async () => {
    const { app, store, github } = setup();
    store.loadCredential.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/reviews/${reviewRunId}/findings/${findingId}/patch-proposals`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'provider_credential_required' });
    expect(github.forInstallation).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });
});
