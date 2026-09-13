import type {
  CommandExecutionResult,
  DeterministicCheckRun,
  ModelReviewResponse,
  ProviderAdapter,
  ProviderUsage,
  RepositoryConfig,
  ReviewRequest,
  StructuredChallengeResult,
  StructuredReviewResult,
} from '@walkz/contracts';
import { createDefaultWalkzConfig } from '@walkz/contracts';
import type {
  ResolvedGitReferences,
  ReviewContext,
} from '@walkz/git';
import { describe, expect, it } from 'vitest';

import {
  digestProofCommand,
  hashWalkzConfig,
  runLocalReviewPipeline,
  type LocalReviewPipelineDependencies,
} from '../src/index.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const NOW = new Date('2026-09-07T10:00:00.000Z');

const references: ResolvedGitReferences = {
  mode: 'branch',
  baseRef: 'main',
  baseTipSha: BASE_SHA,
  baseSha: BASE_SHA,
  headRef: 'HEAD',
  headSha: HEAD_SHA,
  guidanceSha: BASE_SHA,
};

function request(
  overrides: Partial<ReviewRequest> = {},
  config: RepositoryConfig = createDefaultWalkzConfig(),
): ReviewRequest {
  return {
    repositoryRoot: 'C:\\repo with spaces',
    baseRef: 'main',
    headRef: 'HEAD',
    trigger: 'local',
    configVersion: 1,
    configHash: hashWalkzConfig(config),
    runBudget: {
      maxDurationMs: 30_000,
      maxModelTokens: 8_000,
      maxProofAttempts: 0,
    },
    callerCapabilities: {
      canRunCommands: true,
      canUseModel: true,
      canWriteFiles: false,
    },
    ...overrides,
  };
}

function context(
  overrides: Partial<ReviewContext> = {},
): ReviewContext {
  const diff =
    'diff --git a/src/value.ts b/src/value.ts\n' +
    '@@ -1 +1 @@\n-old\n+new\n';
  return {
    references,
    changedFiles: [
      {
        path: 'src/value.ts',
        status: 'modified',
        statusCode: 'M',
        oldMode: '100644',
        newMode: '100644',
        additions: 1,
        deletions: 1,
        kind: 'text',
      },
    ],
    risks: {
      'src/value.ts': { score: 10, reasons: ['source_change'] },
    },
    diff,
    lineIndex: new Map([['src/value.ts', new Set([1])]]),
    guidance: { documents: [], bytes: 0, omissions: [] },
    coverage: {
      complete: true,
      changedFileCount: 1,
      selectedFileCount: 1,
      diffBytes: Buffer.byteLength(diff),
      omissions: [],
    },
    ...overrides,
  };
}

function commandExecution(
  outcome: CommandExecutionResult['outcome'],
  output = '',
): CommandExecutionResult {
  return {
    outcome,
    exitCode:
      outcome === 'succeeded' ? 0 : outcome === 'failed' ? 1 : null,
    signal: null,
    durationMs: 12,
    stdout: {
      text: output,
      originalBytes: Buffer.byteLength(output),
      truncated: false,
      redacted: false,
    },
    stderr: {
      text: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    },
    termination: {
      requested: null,
      accepted: false,
      guarantee: 'best_effort',
    },
  };
}

function checks(
  execution?: CommandExecutionResult,
): DeterministicCheckRun {
  if (execution === undefined) {
    return {
      approval: { status: 'not_required', source: 'none' },
      plannedCount: 0,
      checks: [],
      status: 'complete',
    };
  }
  return {
    approval: { status: 'approved', source: 'trusted_config' },
    plannedCount: 1,
    checks: [
      {
        commandId: 'test',
        required: true,
        command: {
          executable: 'node',
          args: ['test.mjs'],
          repositoryRoot: 'C:\\repo with spaces',
          cwd: '.',
          timeoutMs: 1_000,
          maxOutputBytesPerStream: 4_096,
        },
        execution,
      },
    ],
    status: 'complete',
  };
}

const usage: ProviderUsage = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  latencyMs: 25,
  rateLimit: {
    retryAfterMs: null,
    remainingRequests: 10,
    remainingTokens: 1_000,
    resetRequests: null,
    resetTokens: null,
  },
};

function modelFinding(line = 1): ModelReviewResponse['findings'][number] {
  return {
    category: 'correctness',
    severity: 'high',
    file: 'src/value.ts',
    line,
    claim: 'The changed value breaks the boundary.',
    failureMechanism: 'The caller receives the wrong value.',
    suggestedProof: 'Run the boundary test.',
    confidence: 0.99,
  };
}

function provider(
  review: unknown,
  events: string[] = [],
): ProviderAdapter {
  return {
    name: 'mock',
    listModels: async () => [],
    validateAccess: async () => {
      events.push('access');
      return {
        provider: 'mock',
        selectedModel: 'mock/reviewer',
        models: [
          {
            id: 'mock/reviewer',
            active: true,
            contextWindow: 32_000,
            maxCompletionTokens: 4_000,
            supportsStrictStructuredOutput: true,
          },
        ],
        privacyNotice: 'Local test provider.',
        dataControlsUrl: null,
      };
    },
    requestStructuredReview: async (
      prompt,
    ): Promise<StructuredReviewResult> => {
      events.push('review');
      return {
        provider: 'mock',
        model: prompt.model,
        promptVersion: prompt.promptVersion,
        schemaVersion: 'walkz.review.v1',
        review: review as ModelReviewResponse,
        usage,
        requestId: 'request-1',
      };
    },
  };
}

function providerWithChallenge(
  review: ModelReviewResponse,
  verdict: 'uphold' | 'dispute' | 'needs_human',
  events: string[] = [],
): ProviderAdapter {
  const selected = provider(review, events);
  selected.validateAccess = async () => {
    events.push('access');
    return {
      provider: 'mock',
      selectedModel: 'openai/primary',
      models: [
        {
          id: 'openai/primary',
          active: true,
          contextWindow: 32_000,
          maxCompletionTokens: 4_000,
          supportsStrictStructuredOutput: true,
        },
        {
          id: 'qwen/challenger',
          active: true,
          contextWindow: 32_000,
          maxCompletionTokens: 4_000,
          supportsStrictStructuredOutput: true,
        },
      ],
      privacyNotice: 'Local test provider.',
      dataControlsUrl: null,
    };
  };
  selected.requestStructuredChallenge = async (
    prompt,
  ): Promise<StructuredChallengeResult> => {
    events.push('challenge');
    const payload = JSON.parse(prompt.userPrompt) as {
      findings: Array<{ findingFingerprint: string }>;
    };
    return {
      provider: 'mock',
      model: prompt.model,
      promptVersion: prompt.promptVersion,
      schemaVersion: 'walkz.challenge.v1',
      challenge: {
        decisions: payload.findings.map((finding) => ({
          findingFingerprint: finding.findingFingerprint,
          verdict,
          rationale: 'Independent challenge result.',
        })),
      },
      usage,
      requestId: 'challenge-request-1',
    };
  };
  return selected;
}

function providerWithSecurity(
  review: ModelReviewResponse,
  securityReview: ModelReviewResponse,
  events: string[] = [],
): ProviderAdapter {
  const selected = provider(review, events);
  selected.requestStructuredSecurityReview = async (
    prompt,
  ): Promise<StructuredReviewResult> => {
    events.push('security');
    return {
      provider: 'mock',
      model: prompt.model,
      promptVersion: prompt.promptVersion,
      schemaVersion: 'walkz.review.v1',
      review: securityReview,
      usage,
      requestId: 'security-request-1',
    };
  };
  return selected;
}

function securityContext(): ReviewContext {
  return context({
    risks: {
      'src/value.ts': {
        score: 35,
        reasons: ['security-sensitive path'],
      },
    },
  });
}

function dependencies(
  reviewContext: ReviewContext,
  checkRun: DeterministicCheckRun,
  events: string[] = [],
): LocalReviewPipelineDependencies {
  return {
    resolveReferences: async () => {
      events.push('references');
      return references;
    },
    collectContext: async () => {
      events.push('context');
      return reviewContext;
    },
    runChecks: async () => {
      events.push('checks');
      return checkRun;
    },
  };
}

function configWithCommand(): RepositoryConfig {
  return {
    ...createDefaultWalkzConfig([
      {
        id: 'test',
        executable: 'node',
        args: ['test.mjs'],
        cwd: '.',
        required: true,
      },
    ]),
    commandApprovalPolicy: 'trusted_config',
    blockingEvidenceLevels: ['VERIFIED', 'SUPPORTED'],
  };
}

describe('runLocalReviewPipeline', () => {
  it('sends only provider contract fields for model review', async () => {
    const selectedProvider = provider({ findings: [] });
    const originalRequest = selectedProvider.requestStructuredReview;
    let requestKeys: string[] = [];
    selectedProvider.requestStructuredReview = async (prompt, options) => {
      requestKeys = Object.keys(prompt).sort();
      return originalRequest(prompt, options);
    };

    await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: selectedProvider,
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(requestKeys).toEqual([
      'maxOutputTokens',
      'model',
      'promptVersion',
      'systemPrompt',
      'userPrompt',
    ]);
  });

  it('runs context and checks before requesting a model review', async () => {
    const events: string[] = [];
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: provider({ findings: [modelFinding()] }, events),
      dependencies: dependencies(context(), checks(), events),
      clock: () => NOW,
      runIdFactory: () => 'run-1',
    });

    expect(events).toEqual([
      'references',
      'context',
      'checks',
      'access',
      'review',
    ]);
    expect(result.run).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      verdict: 'SHIP',
      completedAt: NOW.toISOString(),
    });
    expect(result.context?.references).toEqual(references);
    expect(result.run.findings).toEqual([
      expect.objectContaining({
        file: 'src/value.ts',
        line: 1,
        evidenceLevel: 'UNVERIFIED',
      }),
    ]);
    expect(result.provider).toMatchObject({
      status: 'complete',
      provider: 'mock',
      model: 'mock/reviewer',
      promptVersion: 'walkz-review-v1',
      schemaVersion: 'walkz.review.v1',
      usage,
      requestId: 'request-1',
    });
  });

  it('rejects an invented location and returns INCONCLUSIVE', async () => {
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: provider({ findings: [modelFinding(99)] }),
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.run.findings).toEqual([]);
    expect(result.provider).toMatchObject({
      status: 'incomplete',
      failureCode: 'invalid_response',
      rejectedFindings: [{ index: 0, reason: 'line_not_changed' }],
    });
  });

  it('returns INCONCLUSIVE for malformed provider output', async () => {
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: provider({ findings: [{ broken: true }] }),
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.provider.failureCode).toBe('invalid_response');
    expect(result.run.findings).toEqual([]);
  });

  it('turns exact failed-check locations into supported evidence', async () => {
    const failedChecks = checks(
      commandExecution('failed', 'src/value.ts:1 expected true'),
    );
    const result = await runLocalReviewPipeline({
      request: request({}, configWithCommand()),
      config: configWithCommand(),
      provider: provider({ findings: [modelFinding()] }),
      dependencies: dependencies(context(), failedChecks),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('FIX');
    expect(result.run.findings[0]).toMatchObject({
      lifecycleStatus: 'supported',
      evidenceLevel: 'SUPPORTED',
      evidence: [
        {
          kind: 'deterministic_check',
          headOutcome: 'failed',
          headExitCode: 1,
          sanitizedSummary:
            'test failed and referenced src/value.ts:1.',
          commandDigest: digestProofCommand({
            executable: 'node',
            args: ['test.mjs'],
            cwd: '.',
          }),
        },
      ],
    });
  });

  it('routes an unexplained required-check failure to a person', async () => {
    const result = await runLocalReviewPipeline({
      request: request({}, configWithCommand()),
      config: configWithCommand(),
      provider: provider({ findings: [] }),
      dependencies: dependencies(
        context(),
        checks(commandExecution('failed', 'unrelated failure')),
      ),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('HUMAN');
    expect(result.decision.reasons).toEqual([
      'human_judgment_required',
    ]);
  });

  it('does not call the provider when required checks are incomplete', async () => {
    const events: string[] = [];
    const incompleteChecks: DeterministicCheckRun = {
      approval: { status: 'unavailable', source: 'none' },
      plannedCount: 1,
      checks: [],
      status: 'incomplete',
    };
    const result = await runLocalReviewPipeline({
      request: request({}, configWithCommand()),
      config: configWithCommand(),
      provider: provider({ findings: [] }, events),
      dependencies: dependencies(context(), incompleteChecks, events),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.provider.status).toBe('not_requested');
    expect(events).toEqual(['references', 'context', 'checks']);
  });

  it('returns ERROR when check infrastructure fails', async () => {
    const events: string[] = [];
    const failedChecks: DeterministicCheckRun = {
      approval: { status: 'approved', source: 'trusted_config' },
      plannedCount: 1,
      checks: [],
      status: 'error',
    };
    const result = await runLocalReviewPipeline({
      request: request({}, configWithCommand()),
      config: configWithCommand(),
      provider: provider({ findings: [] }, events),
      dependencies: dependencies(context(), failedChecks, events),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('ERROR');
    expect(result.run.status).toBe('failed');
    expect(events).toEqual(['references', 'context', 'checks']);
  });

  it('supports an explicit no-model review without fabricating findings', async () => {
    const result = await runLocalReviewPipeline({
      request: request({
        callerCapabilities: {
          canRunCommands: true,
          canUseModel: false,
          canWriteFiles: false,
        },
      }),
      config: createDefaultWalkzConfig(),
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('SHIP');
    expect(result.provider.status).toBe('not_requested');
    expect(result.run.findings).toEqual([]);
  });

  it('never ships incomplete repository coverage', async () => {
    const incompleteContext = context({
      coverage: {
        complete: false,
        changedFileCount: 2,
        selectedFileCount: 1,
        diffBytes: 50,
        omissions: [{ path: 'large.ts', reason: 'diff_budget' }],
      },
    });
    const result = await runLocalReviewPipeline({
      request: request({
        callerCapabilities: {
          canRunCommands: true,
          canUseModel: false,
          canWriteFiles: false,
        },
      }),
      config: createDefaultWalkzConfig(),
      dependencies: dependencies(incompleteContext, checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.decision.reasons).toContain('context_incomplete');
  });

  it('never ships context truncated while packing the prompt', async () => {
    const largeContext = context({ diff: 'x'.repeat(20_000) });
    const result = await runLocalReviewPipeline({
      request: request({
        runBudget: {
          maxDurationMs: 30_000,
          maxModelTokens: 2_000,
          maxProofAttempts: 0,
        },
      }),
      config: createDefaultWalkzConfig(),
      provider: provider({ findings: [] }),
      dependencies: dependencies(largeContext, checks()),
      clock: () => NOW,
    });

    expect(result.provider.promptTruncated).toBe(true);
    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.decision.reasons).toContain('context_incomplete');
  });

  it('returns INCONCLUSIVE when model use is expected but unconfigured', async () => {
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.provider).toMatchObject({
      status: 'incomplete',
      failureCode: 'not_configured',
    });
  });

  it('rejects a response attributed to a different model', async () => {
    const mismatched = provider({ findings: [] });
    const originalRequest = mismatched.requestStructuredReview;
    mismatched.requestStructuredReview = async (prompt, options) => ({
      ...(await originalRequest(prompt, options)),
      model: 'mock/other',
    });

    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: mismatched,
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.provider.failureCode).toBe('invalid_response');
  });

  it('returns ERROR without running later steps when context fails', async () => {
    const events: string[] = [];
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: provider({ findings: [] }, events),
      dependencies: {
        resolveReferences: async () => {
          events.push('references');
          throw new Error('bad repository');
        },
        collectContext: async () => {
          events.push('context');
          return context();
        },
        runChecks: async () => {
          events.push('checks');
          return checks();
        },
      },
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('ERROR');
    expect(result.run.status).toBe('failed');
    expect(result.failure).toEqual({
      stage: 'context',
      message: 'Repository context could not be collected.',
    });
    expect(events).toEqual(['references']);
  });

  it('records provider cancellation without returning SHIP', async () => {
    const cancelledProvider = provider({ findings: [] });
    cancelledProvider.requestStructuredReview = async () => {
      throw {
        code: 'cancelled',
      };
    };

    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: cancelledProvider,
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.run.verdict).toBe('INCONCLUSIVE');
    expect(result.run.status).toBe('cancelled');
    expect(result.provider.failureCode).toBe('cancelled');
  });

  it('runs the security specialist only for a security-sensitive change', async () => {
    const events: string[] = [];
    const selected = providerWithSecurity(
      { findings: [] },
      {
        findings: [{
          ...modelFinding(),
          category: 'security',
          claim: 'The changed authorization branch accepts another owner.',
          failureMechanism: 'An attacker can bypass the owner comparison.',
        }],
      },
      events,
    );
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: selected,
      enableSecuritySpecialist: true,
      dependencies: dependencies(securityContext(), checks(), events),
      clock: () => NOW,
    });

    expect(events).toEqual([
      'references',
      'context',
      'checks',
      'access',
      'review',
      'security',
    ]);
    expect(result.security).toMatchObject({
      status: 'complete',
      model: 'mock/reviewer',
      promptVersion: 'walkz-security-v1',
    });
    expect(result.run.findings).toEqual([
      expect.objectContaining({
        category: 'security',
        file: 'src/value.ts',
        line: 1,
      }),
    ]);
  });

  it('skips the security specialist for an ordinary source change', async () => {
    const events: string[] = [];
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: providerWithSecurity(
        { findings: [] },
        { findings: [] },
        events,
      ),
      enableSecuritySpecialist: true,
      dependencies: dependencies(context(), checks(), events),
      clock: () => NOW,
    });

    expect(events).not.toContain('security');
    expect(result.security.status).toBe('not_requested');
  });

  it('honours a trusted configuration that disables policy packs', async () => {
    const events: string[] = [];
    const config = {
      ...createDefaultWalkzConfig(),
      policyPacks: [],
    };
    const result = await runLocalReviewPipeline({
      request: request({}, config),
      config,
      provider: providerWithSecurity(
        { findings: [] },
        { findings: [] },
        events,
      ),
      enableSecuritySpecialist: true,
      dependencies: dependencies(securityContext(), checks(), events),
      clock: () => NOW,
    });

    expect(events).not.toContain('security');
    expect(result.security.status).toBe('not_requested');
  });

  it('returns inconclusive when a required security review fails', async () => {
    const selected = providerWithSecurity(
      { findings: [] },
      { findings: [] },
    );
    selected.requestStructuredSecurityReview = async () => {
      throw { code: 'rate_limited' };
    };
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: selected,
      enableSecuritySpecialist: true,
      dependencies: dependencies(securityContext(), checks()),
      clock: () => NOW,
    });

    expect(result.security).toMatchObject({
      status: 'incomplete',
      failureCode: 'request_failed',
    });
    expect(result.run.verdict).toBe('INCONCLUSIVE');
  });

  it('shares one model budget across review, security, and challenge', async () => {
    const events: string[] = [];
    const selected = providerWithChallenge(
      { findings: [modelFinding()] },
      'uphold',
      events,
    );
    let securityOutputBudget = 0;
    selected.requestStructuredSecurityReview = async (prompt) => {
      events.push('security');
      securityOutputBudget = prompt.maxOutputTokens;
      return {
        provider: 'mock',
        model: prompt.model,
        promptVersion: prompt.promptVersion,
        schemaVersion: 'walkz.review.v1',
        review: { findings: [] },
        usage,
        requestId: 'security-request-1',
      };
    };
    const challenge = selected.requestStructuredChallenge!;
    let challengeOutputBudget = 0;
    selected.requestStructuredChallenge = async (prompt, options) => {
      challengeOutputBudget = prompt.maxOutputTokens;
      return challenge(prompt, options);
    };

    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: selected,
      enableSecuritySpecialist: true,
      enableBlockerArbitration: true,
      dependencies: dependencies(securityContext(), checks(), events),
      clock: () => NOW,
    });

    expect(events).toEqual([
      'references',
      'context',
      'checks',
      'access',
      'review',
      'security',
      'challenge',
    ]);
    expect(securityOutputBudget).toBe(1_962);
    expect(challengeOutputBudget).toBe(1_925);
    expect(result.security.status).toBe('complete');
    expect(result.challenger.status).toBe('complete');
  });

  it('challenges only a likely blocker with a second model', async () => {
    const events: string[] = [];
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: providerWithChallenge(
        { findings: [modelFinding()] },
        'uphold',
        events,
      ),
      enableBlockerArbitration: true,
      dependencies: dependencies(context(), checks(), events),
      clock: () => NOW,
    });

    expect(events).toEqual([
      'references',
      'context',
      'checks',
      'access',
      'review',
      'challenge',
    ]);
    expect(result.challenger).toMatchObject({
      status: 'complete',
      model: 'qwen/challenger',
      decisions: [{ verdict: 'uphold' }],
      needsHuman: false,
    });
    expect(result.run.findings[0]?.lifecycleStatus).toBe('challenged');
    expect(result.run.verdict).toBe('SHIP');
  });

  it('does not spend a second call on a low-risk advisory', async () => {
    const events: string[] = [];
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: providerWithChallenge({
        findings: [{ ...modelFinding(), severity: 'low' }],
      }, 'uphold', events),
      enableBlockerArbitration: true,
      dependencies: dependencies(context(), checks(), events),
      clock: () => NOW,
    });

    expect(events).not.toContain('challenge');
    expect(result.challenger.status).toBe('not_requested');
  });

  it('routes a model-only challenger disagreement to a person', async () => {
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: providerWithChallenge(
        { findings: [modelFinding()] },
        'dispute',
      ),
      enableBlockerArbitration: true,
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.challenger.needsHuman).toBe(true);
    expect(result.run.findings[0]).toMatchObject({
      lifecycleStatus: 'challenged',
      dismissal: null,
      evidenceLevel: 'UNVERIFIED',
    });
    expect(result.run.verdict).toBe('HUMAN');
  });

  it('returns inconclusive when required arbitration fails', async () => {
    const selected = providerWithChallenge(
      { findings: [modelFinding()] },
      'uphold',
    );
    selected.requestStructuredChallenge = async () => {
      throw { code: 'rate_limited' };
    };
    const result = await runLocalReviewPipeline({
      request: request(),
      config: createDefaultWalkzConfig(),
      provider: selected,
      enableBlockerArbitration: true,
      dependencies: dependencies(context(), checks()),
      clock: () => NOW,
    });

    expect(result.challenger).toMatchObject({
      status: 'incomplete',
      failureCode: 'request_failed',
    });
    expect(result.run.verdict).toBe('INCONCLUSIVE');
  });

  it('does not let a challenger erase deterministic blocking evidence', async () => {
    const config = configWithCommand();
    const result = await runLocalReviewPipeline({
      request: request({}, config),
      config,
      provider: providerWithChallenge(
        { findings: [modelFinding()] },
        'dispute',
      ),
      enableBlockerArbitration: true,
      dependencies: dependencies(
        context(),
        checks(commandExecution('failed', 'src/value.ts:1 failed')),
      ),
      clock: () => NOW,
    });

    expect(result.run.findings[0]).toMatchObject({
      lifecycleStatus: 'challenged',
      evidenceLevel: 'SUPPORTED',
    });
    expect(result.run.verdict).toBe('FIX');
  });
});
