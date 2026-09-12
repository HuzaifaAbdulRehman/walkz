import type {
  Finding,
  ProofExecutionResult,
  ProofPlan,
} from '@walkz/contracts';
import { createDefaultWalkzConfig, parseProofPlan } from '@walkz/contracts';
import {
  assessCounterfactualProof,
  digestProofCommand,
  fingerprintProofPlan,
  type RunProofPlanInContainersOptions,
} from '@walkz/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitFixture } from '../../../packages/git/test/git-fixture.js';

import {
  proveHostedFindings,
  runHostedDeterministicChecks,
} from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const proofImage = `node@sha256:${'c'.repeat(64)}`;
const repositoryRoot = 'C:/temp/repo';
const workspaceVolume = {
  name: 'walkz-proof-workspaces',
  root: 'C:/temp',
};
const dockerImage = process.env.WALKZ_DOCKER_TEST_IMAGE;
const dockerTest = dockerImage === undefined ? it.skip : it;
const dockerWorkspaceVolume =
  process.env.WALKZ_DOCKER_WORKSPACE_VOLUME === undefined ||
  process.env.WALKZ_PROOF_WORKSPACE_ROOT === undefined
    ? undefined
    : {
        name: process.env.WALKZ_DOCKER_WORKSPACE_VOLUME,
        root: process.env.WALKZ_PROOF_WORKSPACE_ROOT,
      };
const repositories: GitFixture[] = [];
const command = {
  id: 'test',
  executable: 'node',
  args: ['test.mjs'],
  cwd: '.',
  required: true,
};
const config = {
  ...createDefaultWalkzConfig([
    command,
    {
      id: 'typecheck',
      executable: 'node',
      args: ['typecheck.mjs'],
      cwd: '.',
      required: true,
    },
  ]),
  commandApprovalPolicy: 'trusted_config' as const,
};

function proofExecution(
  plan: ProofPlan,
  revision: 'base' | 'head',
  outcome: 'passed' | 'failed',
  summary = '',
): ProofExecutionResult {
  return {
    planDigest: fingerprintProofPlan(plan),
    commandDigest: plan.commandDigest,
    revision,
    sha: revision === 'base' ? baseSha : headSha,
    outcome,
    exitCode: outcome === 'passed' ? 0 : 1,
    durationMs: 12,
    stdout: {
      summary,
      originalBytes: Buffer.byteLength(summary),
      truncated: false,
      redacted: false,
    },
    stderr: {
      summary: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    },
    artifacts: [],
    recordedAt: '2026-09-12T10:00:00.000Z',
  };
}

function supportedFinding(
  commandDigest: string,
  file = 'src/value.ts',
): Finding {
  return {
    fingerprint: 'd'.repeat(64),
    category: 'correctness',
    severity: 'high',
    file,
    line: 1,
    claim: 'The changed value breaks the boundary.',
    failureMechanism: 'The command observes the wrong value.',
    suggestedProof: 'Run the trusted repository test.',
    lifecycleStatus: 'supported',
    evidenceLevel: 'SUPPORTED',
    advisoryConfidence: 0.99,
    evidence: [{
      kind: 'deterministic_check',
      planDigest: null,
      commandDigest,
      baseSha: null,
      headSha: null,
      baseOutcome: null,
      headOutcome: 'failed',
      baseExitCode: null,
      headExitCode: 1,
      durationMs: 12,
      sanitizedSummary: `test failed and referenced ${file}:1.`,
      artifactHashes: [],
      recordedAt: '2026-09-12T10:00:00.000Z',
    }],
    dismissal: null,
    fix: null,
  };
}

const context = {
  reviewRunId,
  baseSha,
  headSha,
  proofImage,
  repositoryRoot,
  config,
  workspaceVolume,
};

afterEach(async () => {
  await Promise.all(repositories.map((repository) => repository.dispose()));
  repositories.length = 0;
});

describe('hosted review proof', () => {
  it('runs trusted checks against the exact head in a locked container', async () => {
    const executeProof = vi.fn(async (
      plan: ProofPlan,
      _planDigest: string,
      _workspace: unknown,
      _options: unknown,
    ) => proofExecution(plan, 'head', 'failed', 'src/value.ts:1 failed'));

    const result = await runHostedDeterministicChecks(context, executeProof);

    expect(result).toMatchObject({
      approval: { status: 'approved', source: 'trusted_config' },
      plannedCount: 2,
      status: 'complete',
    });
    expect(result.checks[0]?.execution).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      stdout: { text: 'src/value.ts:1 failed' },
    });
    const plan = executeProof.mock.calls[0]?.[0];
    expect(executeProof.mock.calls[0]?.[3]).toMatchObject({ workspaceVolume });
    expect(plan).toMatchObject({
      baseSha,
      headSha,
      containerImage: proofImage,
      isolation: {
        network: 'none',
        readOnlyRootFilesystem: true,
        dropCapabilities: 'all',
        noNewPrivileges: true,
      },
      command: {
        executable: 'node',
        args: ['test.mjs'],
        cwd: '.',
      },
    });
  });

  it('promotes a supported finding only after base passes and head fails', async () => {
    const commandDigest = digestProofCommand({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
    });
    const finding = supportedFinding(commandDigest);
    const runProof = vi.fn(async (
      candidate: Finding,
      planInput: unknown,
      options: RunProofPlanInContainersOptions,
    ) => {
      const plan = parseProofPlan(planInput);
      expect(options.authorization.authorizedCommandDigests).toEqual(new Set([
        commandDigest,
        digestProofCommand({
          executable: config.commands[1]?.executable,
          args: config.commands[1]?.args,
          cwd: config.commands[1]?.cwd,
        }),
      ]));
      expect(options.docker).toEqual({ workspaceVolume });
      expect(options.temporaryRoot).toBe(workspaceVolume.root);
      const execution = {
        base: proofExecution(plan, 'base', 'passed'),
        head: proofExecution(plan, 'head', 'failed', 'src/value.ts:1 failed'),
      };
      return {
        execution,
        assessment: assessCounterfactualProof(candidate, plan, execution),
      };
    });

    const result = await proveHostedFindings([finding], context, runProof);

    expect(result.proofStatus).toBe('complete');
    expect(result.findings[0]).toMatchObject({
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      evidence: [
        { kind: 'deterministic_check' },
        {
          kind: 'counterfactual_proof',
          baseSha,
          headSha,
          baseOutcome: 'passed',
          headOutcome: 'failed',
        },
      ],
    });
    expect(runProof).toHaveBeenCalledTimes(1);
  });

  it('marks proof incomplete when failed evidence is not trusted anymore', async () => {
    const runProof = vi.fn();
    const result = await proveHostedFindings(
      [supportedFinding('e'.repeat(64))],
      context,
      runProof,
    );

    expect(result.proofStatus).toBe('incomplete');
    expect(result.findings[0]?.evidenceLevel).toBe('SUPPORTED');
    expect(runProof).not.toHaveBeenCalled();
  });

  dockerTest(
    'verifies a hosted finding through the real locked base and head path',
    async () => {
      const repository = await GitFixture.create();
      repositories.push(repository);
      await repository.write('test.mjs', [
        "import { readFileSync } from 'node:fs';",
        "const source = readFileSync('src/value.js', 'utf8');",
        "if (!source.includes('safe')) console.error('src/value.js:1 regression');",
        "process.exit(source.includes('safe') ? 0 : 1);",
        '',
      ].join('\n'));
      await repository.write('src/value.js', 'export const value = "safe";\n');
      const fixtureBaseSha = await repository.commitAll('base');
      await repository.write('src/value.js', 'export const value = "broken";\n');
      const fixtureHeadSha = await repository.commitAll('head');
      const fixtureConfig = {
        ...createDefaultWalkzConfig([command]),
        commandApprovalPolicy: 'trusted_config' as const,
      };
      const fixtureContext = {
        reviewRunId,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        proofImage: dockerImage!,
        repositoryRoot: repository.root,
        config: fixtureConfig,
        ...(dockerWorkspaceVolume === undefined
          ? {}
          : { workspaceVolume: dockerWorkspaceVolume }),
      };

      const checks = await runHostedDeterministicChecks(fixtureContext);
      expect(checks.checks[0]?.execution.outcome).toBe('failed');
      const supported = supportedFinding(
        digestProofCommand({
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
        }),
        'src/value.js',
      );
      const proof = await proveHostedFindings([supported], fixtureContext);

      expect(proof).toMatchObject({
        proofStatus: 'complete',
        findings: [{
          lifecycleStatus: 'verified',
          evidenceLevel: 'VERIFIED',
          evidence: [
            { kind: 'deterministic_check' },
            {
              kind: 'counterfactual_proof',
              baseSha: fixtureBaseSha,
              headSha: fixtureHeadSha,
              baseOutcome: 'passed',
              headOutcome: 'failed',
            },
          ],
        }],
      });
    },
    60_000,
  );
});
