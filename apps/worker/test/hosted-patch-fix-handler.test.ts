import { createHash } from 'node:crypto';

import {
  createDefaultWalkzConfig,
  type PatchReproofResult,
  type ProviderAdapter,
} from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  digestProofCommand,
  generatePatchCandidate,
  WALKZ_PATCH_PROMPT_VERSION,
} from '@walkz/engine';
import type { ClaimedPatchFixTarget } from '@walkz/persistence';
import { describe, expect, it, vi } from 'vitest';

import { createHostedPatchFixJobHandler } from '../src/index.js';

const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
const repositoryId = '99516fcb-ec21-4a50-8936-d585e77ca154';
const userId = '79f36b7d-919f-480f-931b-cf62ce0141d9';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const proofImage = `node@sha256:${'c'.repeat(64)}`;
const command = { executable: 'npm', args: ['test'], cwd: '.' };
const regressionCommand = { executable: 'npm', args: ['run', 'typecheck'], cwd: '.' };
const fileContent = [
  'export function value(input: string | undefined) {',
  '  const fallback = "safe";',
  '  return input;',
  '}',
  '',
].join('\n');

function provider(): ProviderAdapter {
  return {
    name: 'groq',
    listModels: vi.fn().mockResolvedValue([]),
    validateAccess: vi.fn().mockResolvedValue({
      provider: 'groq',
      selectedModel: 'model',
      models: [{
        id: 'model',
        active: true,
        contextWindow: 32_768,
        maxCompletionTokens: 4_096,
        supportsStrictStructuredOutput: true,
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
          retryAfterMs: null,
          remainingRequests: null,
          remainingTokens: null,
          resetRequests: null,
          resetTokens: null,
        },
      },
      requestId: 'request-1',
    }),
  };
}

async function fixture(patchHash?: string) {
  const config = {
    ...createDefaultWalkzConfig([{
      id: 'test',
      ...command,
      required: true,
    }, {
      id: 'typecheck',
      ...regressionCommand,
      required: true,
    }]),
    commandApprovalPolicy: 'trusted_config' as const,
    provider: { name: 'groq' as const, model: 'model' },
  };
  const selectedProvider = provider();
  const generated = await generatePatchCandidate({
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    currentHeadSha: headSha,
    deliveryMode: 'suggestion',
    model: 'model',
    maxModelTokens: config.tokenBudget,
    finding: {
      path: 'src/value.ts',
      startLine: 3,
      endLine: 3,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      claim: 'The function ignores the fallback value.',
      failureMechanism: 'Undefined is returned instead of the fallback.',
    },
    headFile: { path: 'src/value.ts', content: fileContent },
  }, { provider: selectedProvider });
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
  const now = new Date('2026-09-11T10:00:00.000Z');
  const target: ClaimedPatchFixTarget = {
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
      recordedAt: now,
    },
    proposal: {
      id: proposalId,
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash: patchHash ?? generated.candidate.patchHash,
      deliveryMode: 'suggestion',
      approvalStatus: 'approved',
      githubReference: null,
      decidedByUserId: userId,
      decidedAt: now,
      staleAt: null,
      createdAt: now,
      updatedAt: now,
    },
    job: {
      proposalId,
      provider: 'groq',
      model: 'model',
      promptVersion: WALKZ_PATCH_PROMPT_VERSION,
      proofPlanDigest: binding.planDigest,
      proofCommandDigest: commandDigest,
      status: 'reproving',
      attempt: 1,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
    decidedByUserId: userId,
  };
  return { target, generated, selectedProvider, binding };
}

function reproofResult(
  target: ClaimedPatchFixTarget,
  outcome: PatchReproofResult['outcome'],
): PatchReproofResult {
  return {
    schemaVersion: 1,
    proposalId,
    reviewRunId,
    findingId,
    attempt: 1,
    patchHash: target.proposal.patchHash,
    headSha,
    outcome,
    proof: {
      kind: 'proof',
      planDigest: target.proof.planDigest,
      commandDigest: target.proof.commandDigest,
      outcome: outcome === 'resolved' ? 'passed' : 'failed',
      exitCode: outcome === 'resolved' ? 0 : 1,
      durationMs: 10,
      sanitizedSummary: 'Focused proof completed.',
      artifacts: [],
    },
    regressions: [],
    recordedAt: '2026-09-11T10:01:00.000Z',
  };
}

function dependencies(target: ClaimedPatchFixTarget) {
  const service = {
    loadHeadFile: vi.fn().mockResolvedValue({
      currentHeadSha: headSha,
      path: 'src/value.ts',
      content: fileContent,
    }),
    publish: vi.fn().mockResolvedValue({
      commentId: '42',
      htmlUrl: 'https://github.com/owner/repo/pull/27#discussion_r42',
      created: true,
    }),
  };
  const store = {
    claim: vi.fn().mockResolvedValue(target.job),
    renew: vi.fn().mockResolvedValue(true),
    loadTarget: vi.fn().mockResolvedValue(target),
    loadCredential: vi.fn().mockResolvedValue('secret'),
    latestReproof: vi.fn().mockResolvedValue(null),
    recordReproof: vi.fn(),
    preparePublication: vi.fn().mockResolvedValue({
      outcome: 'ready',
      target: {
        proposal: target.proposal,
        installationId: target.installationId,
        owner: target.owner,
        repository: target.repository,
        pullRequestNumber: target.pullRequestNumber,
      },
    }),
    recordPublication: vi.fn().mockResolvedValue({
      outcome: 'applied',
      target: null,
    }),
    releasePublication: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(target.job),
    release: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(target.job),
  };
  return {
    store,
    service,
    tokens: { getInstallationToken: vi.fn().mockResolvedValue({ token: 'github' }) },
    github: { forInstallation: vi.fn().mockResolvedValue(service) },
  };
}

describe('hosted approved patch fix worker', () => {
  it('reproves before publishing and stores no candidate in queue state', async () => {
    const { target, selectedProvider } = await fixture();
    const deps = dependencies(target);
    const result = reproofResult(target, 'resolved');
    const runReproof = vi.fn().mockResolvedValue({
      result,
      proofExecution: {},
      regressionExecutions: [],
    });
    deps.store.recordReproof.mockResolvedValue({ outcome: 'applied', result });
    const workspaceVolume = {
      name: 'walkz-proof-workspaces',
      root: 'C:/tmp',
    };
    const checkout = vi.fn(async (_input, operation) => operation('C:/tmp/repo'));
    const handler = createHostedPatchFixJobHandler({
      ...deps,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      workspaceVolume,
      createProvider: () => selectedProvider,
      checkout,
      runReproof,
    });

    await handler.handle(proposalId);

    expect(runReproof).toHaveBeenCalledOnce();
    expect(runReproof).toHaveBeenCalledWith(
      expect.objectContaining({
        regressionPlans: [expect.objectContaining({ command: regressionCommand })],
      }),
      expect.objectContaining({
        githubToken: 'github',
        temporaryRoot: workspaceVolume.root,
        docker: { workspaceVolume },
      }),
    );
    expect(checkout).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ temporaryRoot: workspaceVolume.root }),
    );
    expect(deps.store.recordReproof).toHaveBeenCalledWith(result);
    expect(deps.service.publish).toHaveBeenCalledOnce();
    expect(deps.store.recordReproof.mock.invocationCallOrder[0])
      .toBeLessThan(deps.service.publish.mock.invocationCallOrder[0] ?? 0);
    expect(deps.store.complete).toHaveBeenCalledWith({
      proposalId,
      workerId: 'worker-1',
      outcome: 'resolved',
    });
    expect(deps.store.fail).not.toHaveBeenCalled();
  });

  it('resumes an inconclusive reproof without a model call or publication', async () => {
    const { target, selectedProvider } = await fixture();
    const deps = dependencies(target);
    deps.store.latestReproof.mockResolvedValue(reproofResult(target, 'inconclusive'));
    const handler = createHostedPatchFixJobHandler({
      ...deps,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      createProvider: () => selectedProvider,
    });

    await handler.handle(proposalId);

    expect(deps.store.loadCredential).not.toHaveBeenCalled();
    expect(deps.service.publish).not.toHaveBeenCalled();
    expect(deps.store.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'inconclusive',
    }));
  });

  it('fails closed when regenerated patch content changes', async () => {
    const { target, selectedProvider } = await fixture('f'.repeat(64));
    const deps = dependencies(target);
    const runReproof = vi.fn();
    const handler = createHostedPatchFixJobHandler({
      ...deps,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      createProvider: () => selectedProvider,
      runReproof,
    });

    await handler.handle(proposalId);

    expect(runReproof).not.toHaveBeenCalled();
    expect(deps.service.publish).not.toHaveBeenCalled();
    expect(deps.store.fail).toHaveBeenCalledWith({
      proposalId,
      workerId: 'worker-1',
      failureCode: 'candidate_changed',
    });
  });
});
