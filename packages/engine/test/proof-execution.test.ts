import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CapturedOutput,
  CommandExecutionResult,
  ProofCommand,
  ProofResourceLimits,
} from '@walkz/contracts';
import type {
  DockerCommandExecutor,
  DockerProofWorkspace,
} from '@walkz/sandbox';
import { afterEach, describe, expect, it } from 'vitest';

import { GitFixture } from '../../git/test/git-fixture.js';
import {
  createProofPlan,
  digestProofCommand,
  fingerprintProofPlan,
  runAndAssessCounterfactualProof,
  runProofPlanInContainers,
  type ProofBudget,
} from '../src/index.js';

const repositories: GitFixture[] = [];
const temporaryRoots: string[] = [];
const command: ProofCommand = {
  executable: 'node',
  args: ['.walkz-proof/reproducer.mjs'],
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
  maxAttempts: 1,
  maxTotalDurationMs: 30_000,
  maxAttemptDurationMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  maxArtifactBytes: 1024 * 1_024,
  deadlineMs: Date.now() + 60_000,
};
const authorization = {
  authorizedCommandDigests: new Set([digestProofCommand(command)]),
};
const dockerImage = process.env.WALKZ_DOCKER_TEST_IMAGE;
const dockerTest = dockerImage === undefined ? it.skip : it;

function output(text = ''): CapturedOutput {
  return {
    text,
    originalBytes: Buffer.byteLength(text),
    truncated: false,
    redacted: false,
  };
}

function execution(text = '', exitCode = 0): CommandExecutionResult {
  return {
    outcome: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    signal: null,
    durationMs: 10,
    stdout: output(text),
    stderr: output(),
    termination: {
      requested: null,
      accepted: false,
      guarantee: 'best_effort',
    },
  };
}

async function fixture(): Promise<GitFixture> {
  const repository = await GitFixture.create();
  repositories.push(repository);
  return repository;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'walkz proof engine '));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all([
    ...repositories.map((repository) => repository.dispose()),
    ...temporaryRoots.map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  ]);
  repositories.length = 0;
  temporaryRoots.length = 0;
});

describe('runProofPlanInContainers', () => {
  it('binds one approved plan to exact temporary base and head trees', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    await repository.write('value.txt', 'dirty\n');
    const temp = await temporaryRoot();
    const proofPlan = createProofPlan(
      {
        runId: 'run-1',
        findingFingerprint: 'a'.repeat(64),
        baseSha,
        headSha,
        containerImage: 'node:24-alpine@sha256:' + '3'.repeat(64),
        command,
        files: [
          {
            path: '.walkz-proof/reproducer.mjs',
            content: 'process.exit(0);\n',
          },
        ],
        limits,
      },
      authorization,
      budget,
    );
    const seen: Array<Pick<DockerProofWorkspace, 'revision' | 'sha'>> = [];
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] === 'run') {
        const revision = spec.args[2]!.includes('-base-') ? 'base' : 'head';
        seen.push({
          revision,
          sha: revision === 'base' ? baseSha : headSha,
        });
        return execution(await readFile(join(spec.repositoryRoot, 'value.txt'), 'utf8'));
      }
      return execution();
    };

    const result = await runProofPlanInContainers(proofPlan, {
      repositoryRoot: repository.root,
      authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      temporaryRoot: temp,
      docker: {
        executor,
        containerNameFactory: (revision) =>
          'walkz-proof-' + revision + '-fixed',
        containerUser: '1000:1000',
      },
    });

    expect(result.base.stdout.summary).toBe('base\n');
    expect(result.head.stdout.summary).toBe('head\n');
    expect(result.base.planDigest).toBe(fingerprintProofPlan(proofPlan));
    expect(result.head.planDigest).toBe(result.base.planDigest);
    expect(seen).toEqual([
      { revision: 'base', sha: baseSha },
      { revision: 'head', sha: headSha },
    ]);
    await expect(readFile(join(repository.root, 'value.txt'), 'utf8'))
      .resolves.toBe('dirty\n');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  dockerTest(
    'runs exact Git trees through the real locked container path',
    async () => {
      const repository = await fixture();
      await repository.write('value.txt', 'base\n');
      const baseSha = await repository.commitAll('base');
      await repository.write('value.txt', 'head\n');
      const headSha = await repository.commitAll('head');
      await repository.write('value.txt', 'dirty\n');
      const temp = await temporaryRoot();
      const proofPlan = createProofPlan(
        {
          runId: 'real-run',
          findingFingerprint: 'a'.repeat(64),
          baseSha,
          headSha,
          containerImage: dockerImage!,
          command,
          files: [
            {
              path: '.walkz-proof/reproducer.mjs',
              content:
                "import { readFileSync } from 'node:fs';\n" +
                "console.log(readFileSync('value.txt', 'utf8').trim());\n",
            },
          ],
          limits,
        },
        authorization,
        budget,
      );

      const result = await runProofPlanInContainers(proofPlan, {
        repositoryRoot: repository.root,
        authorization,
        budget,
        workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
        temporaryRoot: temp,
      });

      expect(result.base).toMatchObject({
        outcome: 'passed',
        sha: baseSha,
      });
      expect(result.head).toMatchObject({
        outcome: 'passed',
        sha: headSha,
      });
      expect(result.base.stdout.summary.trim()).toBe('base');
      expect(result.head.stdout.summary.trim()).toBe('head');
      await expect(readFile(join(repository.root, 'value.txt'), 'utf8'))
        .resolves.toBe('dirty\n');
      await expect(readdir(temp)).resolves.toEqual([]);
    },
    60_000,
  );

  it('rejects an unapproved plan before materializing workspaces', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();
    const proofPlan = createProofPlan(
      {
        runId: 'run-1',
        findingFingerprint: 'a'.repeat(64),
        baseSha,
        headSha,
        containerImage: 'node:24-alpine@sha256:' + '3'.repeat(64),
        command,
        limits,
      },
      authorization,
      budget,
    );

    await expect(
      runProofPlanInContainers(proofPlan, {
        repositoryRoot: repository.root,
        authorization: { authorizedCommandDigests: new Set() },
        budget,
        workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
        temporaryRoot: temp,
      }),
    ).rejects.toThrow('has not been approved');
    await expect(readdir(temp)).resolves.toEqual([]);
  });
});

describe('runAndAssessCounterfactualProof', () => {
  it('feeds an exact base-pass and head-fail pair into verified evidence', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();
    const finding = {
      fingerprint: 'a'.repeat(64),
      category: 'correctness' as const,
      severity: 'high' as const,
      file: 'value.txt',
      line: 1,
      claim: 'The change regresses the value.',
      failureMechanism: 'The head revision fails the reproducer.',
      suggestedProof: 'Run the reproducer.',
      lifecycleStatus: 'unverified' as const,
      evidenceLevel: 'UNVERIFIED' as const,
      advisoryConfidence: 0.9,
      evidence: [],
      dismissal: null,
      fix: null,
    };
    const proofPlan = createProofPlan(
      {
        runId: 'run-1',
        findingFingerprint: finding.fingerprint,
        baseSha,
        headSha,
        containerImage: 'node:24-alpine@sha256:' + '3'.repeat(64),
        command,
        limits,
      },
      authorization,
      budget,
    );
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] !== 'run') {
        return execution();
      }
      return spec.args[2]!.includes('-base-')
        ? execution('base passes\n')
        : execution('head fails\n', 1);
    };

    const result = await runAndAssessCounterfactualProof(finding, proofPlan, {
      repositoryRoot: repository.root,
      authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      temporaryRoot: temp,
      docker: {
        executor,
        containerNameFactory: (revision) =>
          'walkz-proof-' + revision + '-fixed',
        containerUser: '1000:1000',
      },
    });

    expect(result.execution).toMatchObject({
      base: { outcome: 'passed', sha: baseSha },
      head: { outcome: 'failed', sha: headSha },
    });
    expect(result.assessment).toMatchObject({
      classification: 'verified',
      proofStatus: 'complete',
      finding: { evidenceLevel: 'VERIFIED' },
      evidence: { planDigest: fingerprintProofPlan(proofPlan) },
    });
  });

  it('returns incomplete evidence when the proof cannot be materialized', async () => {
    const proofPlan = createProofPlan(
      {
        runId: 'run-1',
        findingFingerprint: 'a'.repeat(64),
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        containerImage: 'node:24-alpine@sha256:' + '3'.repeat(64),
        command,
        limits,
      },
      authorization,
      budget,
    );
    const finding = {
      fingerprint: 'a'.repeat(64),
      category: 'correctness' as const,
      severity: 'high' as const,
      file: 'value.txt',
      line: 1,
      claim: 'The change regresses the value.',
      failureMechanism: 'The head revision fails the reproducer.',
      suggestedProof: 'Run the reproducer.',
      lifecycleStatus: 'unverified' as const,
      evidenceLevel: 'UNVERIFIED' as const,
      advisoryConfidence: 0.9,
      evidence: [],
      dismissal: null,
      fix: null,
    };

    const result = await runAndAssessCounterfactualProof(finding, proofPlan, {
      repositoryRoot: 'not-a-repository',
      authorization,
      budget,
      workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
    });

    expect(result).toMatchObject({
      execution: null,
      assessment: {
        classification: 'incomplete',
        proofStatus: 'incomplete',
        reason: 'execution_incomplete',
        evidence: null,
      },
    });
  });

  dockerTest(
    'verifies a regression through the real locked container path',
    async () => {
      const repository = await fixture();
      await repository.write('value.txt', 'base\n');
      const baseSha = await repository.commitAll('base');
      await repository.write('value.txt', 'broken\n');
      const headSha = await repository.commitAll('head');
      const finding = {
        fingerprint: 'a'.repeat(64),
        category: 'correctness' as const,
        severity: 'high' as const,
        file: 'value.txt',
        line: 1,
        claim: 'The change regresses the value.',
        failureMechanism: 'The head revision fails the reproducer.',
        suggestedProof: 'Run the reproducer.',
        lifecycleStatus: 'unverified' as const,
        evidenceLevel: 'UNVERIFIED' as const,
        advisoryConfidence: 0.9,
        evidence: [],
        dismissal: null,
        fix: null,
      };
      const proofPlan = createProofPlan(
        {
          runId: 'real-regression',
          findingFingerprint: finding.fingerprint,
          baseSha,
          headSha,
          containerImage: dockerImage!,
          command,
          files: [
            {
              path: '.walkz-proof/reproducer.mjs',
              content:
                "import { readFileSync } from 'node:fs';\n" +
                "process.exit(readFileSync('value.txt', 'utf8') === 'base\\n' ? 0 : 1);\n",
            },
          ],
          limits,
        },
        authorization,
        budget,
      );

      const result = await runAndAssessCounterfactualProof(finding, proofPlan, {
        repositoryRoot: repository.root,
        authorization,
        budget,
        workspaceLimits: { maxFiles: 100, maxBytes: 1024 * 1_024 },
      });

      expect(result).toMatchObject({
        execution: {
          base: { outcome: 'passed', sha: baseSha },
          head: { outcome: 'failed', sha: headSha },
        },
        assessment: {
          classification: 'verified',
          proofStatus: 'complete',
          finding: { evidenceLevel: 'VERIFIED' },
        },
      });
    },
    60_000,
  );
});
