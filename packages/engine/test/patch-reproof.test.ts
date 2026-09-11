import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseProofExecutionResult,
  type CapturedOutput,
  type CommandExecutionResult,
  type Finding,
  type ModelPatchResponse,
  type ProviderAdapter,
  type ProofResourceLimits,
} from '@walkz/contracts';
import type { DockerCommandExecutor } from '@walkz/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitFixture } from '../../git/test/git-fixture.js';
import {
  createProofPlan,
  digestProofCommand,
  fingerprintProofPlan,
  generatePatchCandidate,
  runApprovedPatchReproof,
  WALKZ_PATCH_PROMPT_VERSION,
  type ProofBudget,
} from '../src/index.js';

const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const reviewRunId = 'f931b8c5-f267-4b1b-8cb4-273695d4448e';
const findingId = '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68';
const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const dockerImage = process.env.WALKZ_DOCKER_TEST_IMAGE;
const dockerTest = dockerImage === undefined ? it.skip : it;
const repositories: GitFixture[] = [];
const temporaryRoots: string[] = [];
const proofCommand = {
  executable: 'node',
  args: ['.walkz-proof/reproducer.mjs'],
  cwd: '.',
};
const regressionCommand = {
  executable: 'node',
  args: ['.walkz-proof/regression.mjs'],
  cwd: '.',
};
const limits: ProofResourceLimits = {
  timeoutMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  memoryBytes: 256 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 64,
  maxWritableBytes: 1024 * 1_024,
};
const budget: ProofBudget = {
  maxAttempts: 2,
  maxTotalDurationMs: 30_000,
  maxAttemptDurationMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  maxArtifactBytes: 1024 * 1_024,
  deadlineMs: Date.now() + 60_000,
};

function captured(text = ''): CapturedOutput {
  return {
    text,
    originalBytes: Buffer.byteLength(text),
    truncated: false,
    redacted: false,
  };
}

function commandResult(
  outcome: CommandExecutionResult['outcome'],
  text = '',
): CommandExecutionResult {
  const exitCode = outcome === 'succeeded' ? 0 : outcome === 'failed' ? 1 : null;
  return {
    outcome,
    exitCode,
    signal: null,
    durationMs: 10,
    stdout: captured(text),
    stderr: captured(),
    termination: {
      requested: null,
      accepted: false,
      guarantee: 'best_effort',
    },
  };
}

function patchProvider(headSha: string): ProviderAdapter {
  const patch: ModelPatchResponse = {
    findingId,
    headSha,
    path: 'src/value.ts',
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

async function fixture(options: {
  containerImage?: string;
  proofScript?: string;
  regressionScript?: string;
  planLimits?: typeof limits;
} = {}) {
  const repository = await GitFixture.create();
  repositories.push(repository);
  const baseContent = [
    'export function value(input: string | undefined) {',
    '  const fallback = "safe";',
    '  return input ?? fallback;',
    '}',
    '',
  ].join('\n');
  const headContent = baseContent.replace('return input ?? fallback;', 'return input;');
  await repository.write('src/value.ts', baseContent);
  const baseSha = await repository.commitAll('base');
  await repository.write('src/value.ts', headContent);
  const headSha = await repository.commitAll('head');
  const generated = await generatePatchCandidate({
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    currentHeadSha: headSha,
    deliveryMode: 'suggestion',
    model: 'mock/patcher',
    maxModelTokens: 16_000,
    finding: {
      path: 'src/value.ts',
      startLine: 3,
      endLine: 3,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      claim: 'The function ignores the fallback value.',
      failureMechanism: 'Undefined is returned instead of the fallback.',
    },
    headFile: { path: 'src/value.ts', content: headContent },
  }, { provider: patchProvider(headSha) });
  const finding: Finding = {
    fingerprint: 'a'.repeat(64),
    category: 'correctness',
    severity: 'high',
    file: 'src/value.ts',
    line: 3,
    claim: 'The function ignores the fallback value.',
    failureMechanism: 'Undefined is returned instead of the fallback.',
    suggestedProof: 'Run the reproducer.',
    lifecycleStatus: 'verified',
    evidenceLevel: 'VERIFIED',
    advisoryConfidence: 0.95,
    evidence: [],
    dismissal: null,
    fix: null,
  };
  const authorization = {
    authorizedCommandDigests: new Set([
      digestProofCommand(proofCommand),
      digestProofCommand(regressionCommand),
    ]),
  };
  const proofPlan = createProofPlan({
    runId: reviewRunId,
    findingFingerprint: finding.fingerprint,
    baseSha,
    headSha,
    containerImage: options.containerImage ?? 'node:24-alpine@sha256:' + '3'.repeat(64),
    command: proofCommand,
    files: [{
      path: '.walkz-proof/reproducer.mjs',
      content: options.proofScript ?? 'process.exit(0);\n',
    }],
    limits: options.planLimits ?? limits,
  }, authorization, budget);
  const regressionPlan = createProofPlan({
    runId: reviewRunId,
    findingFingerprint: finding.fingerprint,
    baseSha,
    headSha,
    containerImage: options.containerImage ?? 'node:24-alpine@sha256:' + '3'.repeat(64),
    command: regressionCommand,
    files: [{
      path: '.walkz-proof/regression.mjs',
      content: options.regressionScript ?? 'process.exit(0);\n',
    }],
    limits: options.planLimits ?? limits,
  }, authorization, budget);
  const originalExecution = {
    base: parseProofExecutionResult({
      planDigest: fingerprintProofPlan(proofPlan),
      commandDigest: proofPlan.commandDigest,
      revision: 'base',
      sha: baseSha,
      outcome: 'passed',
      exitCode: 0,
      durationMs: 10,
      stdout: { summary: 'base passes', originalBytes: 11, truncated: false, redacted: false },
      stderr: { summary: '', originalBytes: 0, truncated: false, redacted: false },
      artifacts: [],
      recordedAt: '2026-09-11T00:00:00.000Z',
    }),
    head: parseProofExecutionResult({
      planDigest: fingerprintProofPlan(proofPlan),
      commandDigest: proofPlan.commandDigest,
      revision: 'head',
      sha: headSha,
      outcome: 'failed',
      exitCode: 1,
      durationMs: 10,
      stdout: { summary: 'head fails', originalBytes: 10, truncated: false, redacted: false },
      stderr: { summary: '', originalBytes: 0, truncated: false, redacted: false },
      artifacts: [],
      recordedAt: '2026-09-11T00:00:01.000Z',
    }),
  };
  const decidedAt = new Date('2026-09-11T00:01:00.000Z');
  return {
    repository,
    baseContent,
    headContent,
    baseSha,
    headSha,
    finding,
    candidate: generated.candidate,
    proposal: {
      id: proposalId,
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash: generated.candidate.patchHash,
      deliveryMode: 'suggestion' as const,
      approvalStatus: 'approved' as const,
      githubReference: null,
      decidedByUserId: actorUserId,
      decidedAt,
      staleAt: null,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      updatedAt: decidedAt,
    },
    proofPlan,
    regressionPlan,
    originalExecution,
    authorization,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'walkz reproof test '));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all([
    ...repositories.map((repository) => repository.dispose()),
    ...temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
  repositories.length = 0;
  temporaryRoots.length = 0;
});

describe('approved patch reproof', () => {
  it('marks a fix resolved only when proof and regressions pass in the patched checkout', async () => {
    const data = await fixture();
    const temp = await temporaryRoot();
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] !== 'run') return commandResult('succeeded');
      const content = await readFile(join(spec.repositoryRoot, 'src/value.ts'), 'utf8');
      return content.includes('return input ?? fallback;')
        ? commandResult('succeeded', 'passes\n')
        : commandResult('failed', 'fails\n');
    };

    const run = await runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [data.regressionPlan],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      temporaryRoot: temp,
      docker: {
        executor,
        containerNameFactory: () => 'walkz-reproof-fixed',
        containerUser: '1000:1000',
      },
    });

    expect(run.result).toMatchObject({
      proposalId,
      reviewRunId,
      findingId,
      attempt: 1,
      patchHash: data.candidate.patchHash,
      headSha: data.headSha,
      outcome: 'resolved',
      proof: { outcome: 'passed' },
      regressions: [{ outcome: 'passed' }],
    });
    await expect(readFile(join(data.repository.root, 'src/value.ts'), 'utf8'))
      .resolves.toBe(data.headContent);
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('records unresolved when the original proof still fails after the patch', async () => {
    const data = await fixture();
    const executor: DockerCommandExecutor = async (spec) =>
      spec.args[0] === 'run'
        ? commandResult('failed', 'still broken\n')
        : commandResult('succeeded');

    const run = await runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      docker: { executor, containerUser: '1000:1000' },
    });

    expect(run.result).toMatchObject({
      outcome: 'unresolved',
      proof: { outcome: 'failed', exitCode: 1 },
    });
  });

  it('stays inconclusive when a required regression cannot finish', async () => {
    const data = await fixture();
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] !== 'run') return commandResult('succeeded');
      return spec.args.includes('.walkz-proof/regression.mjs')
        ? commandResult('timed_out')
        : commandResult('succeeded');
    };

    const run = await runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [data.regressionPlan],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      docker: { executor, containerUser: '1000:1000' },
    });

    expect(run.result).toMatchObject({
      outcome: 'inconclusive',
      proof: { outcome: 'passed' },
      regressions: [{ outcome: 'timed_out' }],
    });
  });

  it('stays unresolved when one regression fails and another cannot finish', async () => {
    const data = await fixture();
    const secondRegression = {
      ...data.regressionPlan,
      files: data.regressionPlan.files.map((file) => ({
        ...file,
        path: '.walkz-proof/second-regression.mjs',
      })),
      command: {
        ...data.regressionPlan.command,
        args: ['.walkz-proof/second-regression.mjs'],
      },
    };
    secondRegression.commandDigest = digestProofCommand(secondRegression.command);
    data.authorization.authorizedCommandDigests.add(secondRegression.commandDigest);
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] !== 'run') return commandResult('succeeded');
      if (spec.args.includes('.walkz-proof/reproducer.mjs')) {
        return commandResult('succeeded');
      }
      return spec.args.includes('.walkz-proof/regression.mjs')
        ? commandResult('failed')
        : commandResult('timed_out');
    };

    const run = await runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [data.regressionPlan, secondRegression],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget: { ...budget, maxAttempts: 3 },
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      docker: { executor, containerUser: '1000:1000' },
    });

    expect(run.result).toMatchObject({
      outcome: 'unresolved',
      regressions: [{ outcome: 'failed' }, { outcome: 'timed_out' }],
    });
  });

  it('cancels remaining checks when the total reproof budget expires', async () => {
    const data = await fixture({
      planLimits: { ...limits, timeoutMs: 100 },
    });
    const executor: DockerCommandExecutor = async (spec, options) => {
      if (spec.args[0] !== 'run') return commandResult('succeeded');
      if (spec.args.includes('.walkz-proof/reproducer.mjs')) {
        return commandResult('succeeded');
      }
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted === true) return resolve();
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return commandResult('cancelled');
    };

    const run = await runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [data.regressionPlan],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget: {
        ...budget,
        maxTotalDurationMs: 100,
        maxAttemptDurationMs: 100,
        deadlineMs: Date.now() + 15_000,
      },
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      docker: { executor, containerUser: '1000:1000' },
    });

    expect(run.result).toMatchObject({
      outcome: 'inconclusive',
      proof: { outcome: 'passed' },
      regressions: [{ outcome: 'cancelled' }],
    });
  });

  it('refuses unapproved or stale patch data before materializing a workspace', async () => {
    const data = await fixture();
    const temp = await temporaryRoot();
    for (const proposal of [
      { ...data.proposal, approvalStatus: 'pending', decidedByUserId: null, decidedAt: null },
      { ...data.proposal, staleAt: new Date('2026-09-11T00:02:00.000Z') },
    ]) {
      await expect(runApprovedPatchReproof({
        attempt: 1,
        finding: data.finding,
        proposal,
        candidate: data.candidate,
        proofPlan: data.proofPlan,
        originalExecution: data.originalExecution,
        regressionPlans: [],
      }, {
        repositoryRoot: data.repository.root,
        authorization: data.authorization,
        budget,
        workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
        temporaryRoot: temp,
      })).rejects.toThrow();
    }
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('rejects a proof that was never verified against base and head', async () => {
    const data = await fixture();
    await expect(runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: {
        ...data.originalExecution,
        head: { ...data.originalExecution.head, outcome: 'passed', exitCode: 0 },
      },
      regressionPlans: [],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
    })).rejects.toThrow('verified');
  });

  it('rejects an expired reproof budget before creating workspaces', async () => {
    const data = await fixture();
    const temp = await temporaryRoot();

    await expect(runApprovedPatchReproof({
      attempt: 1,
      finding: data.finding,
      proposal: data.proposal,
      candidate: data.candidate,
      proofPlan: data.proofPlan,
      originalExecution: data.originalExecution,
      regressionPlans: [],
    }, {
      repositoryRoot: data.repository.root,
      authorization: data.authorization,
      budget: { ...budget, deadlineMs: Date.now() - 1 },
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      temporaryRoot: temp,
    })).rejects.toThrow('deadline');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  dockerTest(
    'reproves an approved fix through the real locked container path',
    async () => {
      const proofScript = [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('src/value.ts', 'utf8');",
        "process.exit(source.includes('return input ?? fallback;') ? 0 : 1);",
        '',
      ].join('\n');
      const data = await fixture({
        containerImage: dockerImage!,
        proofScript,
        regressionScript: proofScript,
      });
      const temp = await temporaryRoot();

      const run = await runApprovedPatchReproof({
        attempt: 1,
        finding: data.finding,
        proposal: data.proposal,
        candidate: data.candidate,
        proofPlan: data.proofPlan,
        originalExecution: data.originalExecution,
        regressionPlans: [data.regressionPlan],
      }, {
        repositoryRoot: data.repository.root,
        authorization: data.authorization,
        budget,
        workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
        temporaryRoot: temp,
      });

      expect(run.result).toMatchObject({
        outcome: 'resolved',
        proof: { outcome: 'passed' },
        regressions: [{ outcome: 'passed' }],
      });
      await expect(readFile(join(data.repository.root, 'src/value.ts'), 'utf8'))
        .resolves.toBe(data.headContent);
      await expect(readdir(temp)).resolves.toEqual([]);
    },
    60_000,
  );
});
