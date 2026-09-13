import type { Evidence, Finding, ProviderAdapter } from '@walkz/contracts';
import { createDefaultWalkzConfig } from '@walkz/contracts';
import {
  digestProofCommand,
  hashWalkzConfig,
  WALKZ_REVIEW_PROMPT_VERSION,
} from '@walkz/engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createHostedReviewJobHandler,
  type HostedReviewStore,
} from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const repositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const proofImage = `node@sha256:${'c'.repeat(64)}`;
const workspaceVolume = {
  name: 'walkz-proof-workspaces',
  root: 'C:/temp',
};
const config = createDefaultWalkzConfig();
const claimed = {
  reviewRunId,
  repositoryId,
  installationId: '1234',
  owner: 'owner',
  repository: 'repo',
  pullRequestNumber: 7,
  baseSha,
  headSha,
  configHash: hashWalkzConfig(config),
  config,
  provider: 'groq',
  model: 'auto',
  promptVersion: WALKZ_REVIEW_PROMPT_VERSION,
  status: 'collecting_context' as const,
};

function store(overrides: Partial<HostedReviewStore> = {}): HostedReviewStore {
  return {
    claim: vi.fn().mockResolvedValue(claimed),
    renew: vi.fn().mockResolvedValue(true),
    loadCredential: vi.fn().mockResolvedValue('groq-key'),
    recordModelInvocation: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({
      reviewRunId,
      outboxEventId: repositoryId,
      created: true,
    }),
    ...overrides,
  };
}

function pipelineResult(verdict: 'SHIP' | 'INCONCLUSIVE' = 'SHIP') {
  return {
    decision: { verdict, reasons: [] },
    run: { findings: [] },
  } as never;
}

function proofPipelineResult(
  finding: Finding,
  options: {
    checkOutcome?: 'succeeded' | 'failed';
    securityStatus?: 'complete' | 'not_requested' | 'incomplete';
    securityPromptTruncated?: boolean;
    challengerStatus?: 'complete' | 'not_requested' | 'incomplete';
    challengerNeedsHuman?: boolean;
    challengerPromptTruncated?: boolean;
  } = {},
) {
  return {
    decision: { verdict: 'HUMAN', reasons: ['human_judgment_required'] },
    run: { config, findings: [finding] },
    context: { coverage: { complete: true } },
    deterministicChecks: {
      status: 'complete',
      checks: [{
        required: true,
        execution: { outcome: options.checkOutcome ?? 'failed' },
      }],
    },
    provider: { status: 'complete', promptTruncated: false },
    security: {
      status: options.securityStatus ?? 'not_requested',
      promptTruncated: options.securityPromptTruncated ?? false,
    },
    challenger: {
      status: options.challengerStatus ?? 'not_requested',
      needsHuman: options.challengerNeedsHuman ?? false,
      promptTruncated: options.challengerPromptTruncated ?? false,
    },
    failure: null,
  } as never;
}

function evidence(kind: Evidence['kind']): Evidence {
  return {
    kind,
    planDigest: kind === 'counterfactual_proof' ? 'e'.repeat(64) : null,
    commandDigest: digestProofCommand({
      executable: 'node',
      args: ['test.mjs'],
      cwd: '.',
    }),
    baseSha: kind === 'counterfactual_proof' ? baseSha : null,
    headSha: kind === 'counterfactual_proof' ? headSha : null,
    baseOutcome: kind === 'counterfactual_proof' ? 'passed' : null,
    headOutcome: 'failed',
    baseExitCode: kind === 'counterfactual_proof' ? 0 : null,
    headExitCode: 1,
    durationMs: 20,
    sanitizedSummary: 'Bound proof output.',
    artifactHashes: [],
    recordedAt: '2026-09-12T10:00:00.000Z',
  };
}

function finding(evidenceItems: Evidence[]): Finding {
  return {
    fingerprint: 'd'.repeat(64),
    category: 'correctness',
    severity: 'high',
    file: 'src/value.ts',
    line: 1,
    claim: 'The changed value breaks the boundary.',
    failureMechanism: 'The test observes the wrong value.',
    suggestedProof: 'Run the trusted test.',
    lifecycleStatus: evidenceItems.some((item) =>
      item.kind === 'counterfactual_proof') ? 'verified' : 'supported',
    evidenceLevel: evidenceItems.some((item) =>
      item.kind === 'counterfactual_proof') ? 'VERIFIED' : 'SUPPORTED',
    advisoryConfidence: 0.99,
    evidence: evidenceItems,
    dismissal: null,
    fix: null,
  };
}

function telemetryProvider(): ProviderAdapter {
  return {
    name: 'groq',
    listModels: vi.fn().mockResolvedValue([]),
    validateAccess: vi.fn().mockResolvedValue({
      provider: 'groq',
      selectedModel: 'model',
      models: [],
      privacyNotice: 'Test provider.',
      dataControlsUrl: null,
    }),
    requestStructuredReview: vi.fn().mockResolvedValue({
      provider: 'groq',
      model: 'model',
      promptVersion: WALKZ_REVIEW_PROMPT_VERSION,
      schemaVersion: 'walkz-review-v1',
      review: { findings: [] },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        latencyMs: 20,
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

function pipelineThatCallsProvider() {
  return vi.fn().mockImplementation(async (pipelineInput) => {
    await pipelineInput.provider.requestStructuredReview({
      model: 'model',
      systemPrompt: 'private system prompt',
      userPrompt: 'private source code',
      maxOutputTokens: 1_000,
      promptVersion: WALKZ_REVIEW_PROMPT_VERSION,
    });
    return pipelineResult();
  });
}

describe('hosted review job handler', () => {
  it('reviews exact revisions and stores the terminal outcome', async () => {
    const reviewStore = store();
    const checkout = vi.fn(async (_input, operation) => operation('C:/temp/repo'));
    const provider = { name: 'groq' };
    const createProvider = vi.fn().mockReturnValue(provider);
    const runPipeline = vi.fn().mockResolvedValue(pipelineResult());
    const references = {
      mode: 'branch' as const,
      baseRef: 'refs/walkz/base',
      baseTipSha: baseSha,
      baseSha,
      headRef: 'HEAD',
      headSha,
      guidanceSha: baseSha,
    };
    const resolveReferences = vi.fn().mockResolvedValue(references);
    const collectContext = vi.fn().mockResolvedValue({});
    const tokens = {
      getInstallationToken: vi.fn().mockResolvedValue({
        token: 'installation-token',
        expiresAt: '2026-09-10T02:00:00.000Z',
      }),
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout,
      collectContext,
      createProvider,
      resolveReferences,
      runPipeline,
    });

    await handler.handle(reviewRunId);

    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha, headSha, githubToken: 'installation-token' }),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(createProvider).toHaveBeenCalledWith('groq-key');
    expect(runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        baseRef: 'refs/walkz/base',
        callerCapabilities: {
          canRunCommands: true,
          canUseModel: true,
          canWriteFiles: false,
        },
      }),
      provider: expect.objectContaining({ name: 'groq' }),
      enableBlockerArbitration: true,
      enableSecuritySpecialist: true,
    }));
    expect(runPipeline.mock.calls[0]?.[0].provider).not.toBe(provider);
    const pipelineInput = runPipeline.mock.calls[0]?.[0];
    const dependencies = pipelineInput?.dependencies;
    await dependencies?.resolveReferences?.('C:/temp/repo', { staged: false });
    await dependencies?.collectContext?.(
      'C:/temp/repo',
      references,
      { fileBudget: 1, diffBudgetBytes: 1 },
    );
    expect(resolveReferences).toHaveBeenCalledWith(
      'C:/temp/repo',
      expect.objectContaining({ githubToken: 'installation-token' }),
    );
    expect(collectContext).toHaveBeenCalledWith(
      'C:/temp/repo',
      references,
      expect.objectContaining({ githubToken: 'installation-token' }),
    );
    expect(JSON.stringify(pipelineInput)).not.toContain('installation-token');
    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      reviewRunId,
      workerId: 'worker-1',
      verdict: 'SHIP',
      baseSha,
      headSha,
    }));
  });

  it('records hosted provider calls without their prompt content', async () => {
    const reviewStore = store();
    const runPipeline = pipelineThatCallsProvider();
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      createProvider: () => telemetryProvider(),
      runPipeline,
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.recordModelInvocation).toHaveBeenCalledWith({
      reviewRunId,
      event: expect.objectContaining({
        stage: 'review',
        status: 'succeeded',
        requestId: 'request-1',
      }),
    });
    const recorded = JSON.stringify(
      vi.mocked(reviewStore.recordModelInvocation).mock.calls[0]?.[0],
    );
    expect(recorded).not.toContain('private system prompt');
    expect(recorded).not.toContain('private source code');
  });

  it('does not complete successfully when invocation recording fails', async () => {
    const reviewStore = store({
      recordModelInvocation: vi.fn().mockRejectedValue(
        new Error('database unavailable'),
      ),
    });
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      createProvider: () => telemetryProvider(),
      runPipeline: pipelineThatCallsProvider(),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'ERROR',
      findings: [],
    }));
  });

  it('runs model review as inconclusive when no credential exists', async () => {
    const reviewStore = store({
      loadCredential: vi.fn().mockResolvedValue(null),
    });
    const runPipeline = vi.fn().mockResolvedValue(pipelineResult('INCONCLUSIVE'));
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline,
    });

    await handler.handle(reviewRunId);

    expect(runPipeline.mock.calls[0]?.[0]).not.toHaveProperty('provider');
    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'INCONCLUSIVE',
    }));
  });

  it('stores only bound proof evidence after verification', async () => {
    const reviewStore = store();
    const supported = finding([evidence('deterministic_check')]);
    const verified = finding([
      evidence('deterministic_check'),
      evidence('counterfactual_proof'),
    ]);
    const proveFindings = vi.fn().mockResolvedValue({
      findings: [verified],
      proofStatus: 'complete',
    });
    const checkout = vi.fn(async (_input, operation) => operation('C:/temp/repo'));
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      workspaceVolume,
      checkout,
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(supported)),
      proveFindings,
    });

    await handler.handle(reviewRunId);

    expect(proveFindings).toHaveBeenCalledWith(
      [supported],
      expect.objectContaining({
        reviewRunId,
        baseSha,
        headSha,
        proofImage,
        repositoryRoot: 'C:/temp/repo',
        workspaceVolume,
      }),
    );
    expect(checkout).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ temporaryRoot: workspaceVolume.root }),
    );
    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'FIX',
      findings: [expect.objectContaining({
        evidenceLevel: 'VERIFIED',
        lifecycleStatus: 'verified',
        evidence: [expect.objectContaining({
          kind: 'counterfactual_proof',
          baseSha,
          headSha,
        })],
      })],
    }));
  });

  it('preserves challenger disagreement after proof adjudication', async () => {
    const reviewStore = store();
    const advisory = {
      ...finding([]),
      lifecycleStatus: 'challenged' as const,
      evidenceLevel: 'UNVERIFIED' as const,
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(advisory, {
        checkOutcome: 'succeeded',
        challengerStatus: 'complete',
        challengerNeedsHuman: true,
      })),
      proveFindings: vi.fn().mockResolvedValue({
        findings: [advisory],
        proofStatus: 'not_requested',
      }),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'HUMAN',
    }));
  });

  it('preserves incomplete arbitration after proof adjudication', async () => {
    const reviewStore = store();
    const advisory = {
      ...finding([]),
      lifecycleStatus: 'proposed' as const,
      evidenceLevel: 'UNVERIFIED' as const,
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(advisory, {
        checkOutcome: 'succeeded',
        challengerStatus: 'incomplete',
      })),
      proveFindings: vi.fn().mockResolvedValue({
        findings: [advisory],
        proofStatus: 'not_requested',
      }),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'INCONCLUSIVE',
    }));
  });

  it('preserves an incomplete security review after proof adjudication', async () => {
    const reviewStore = store();
    const advisory = {
      ...finding([]),
      lifecycleStatus: 'proposed' as const,
      evidenceLevel: 'UNVERIFIED' as const,
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(advisory, {
        checkOutcome: 'succeeded',
        securityStatus: 'incomplete',
      })),
      proveFindings: vi.fn().mockResolvedValue({
        findings: [advisory],
        proofStatus: 'not_requested',
      }),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'INCONCLUSIVE',
    }));
  });

  it('preserves truncated security context after proof adjudication', async () => {
    const reviewStore = store();
    const advisory = {
      ...finding([]),
      lifecycleStatus: 'proposed' as const,
      evidenceLevel: 'UNVERIFIED' as const,
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(advisory, {
        checkOutcome: 'succeeded',
        securityStatus: 'complete',
        securityPromptTruncated: true,
      })),
      proveFindings: vi.fn().mockResolvedValue({
        findings: [advisory],
        proofStatus: 'not_requested',
      }),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'INCONCLUSIVE',
    }));
  });

  it('preserves truncated challenge context after proof adjudication', async () => {
    const reviewStore = store();
    const advisory = {
      ...finding([]),
      lifecycleStatus: 'challenged' as const,
      evidenceLevel: 'UNVERIFIED' as const,
    };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(proofPipelineResult(advisory, {
        checkOutcome: 'succeeded',
        challengerStatus: 'complete',
        challengerPromptTruncated: true,
      })),
      proveFindings: vi.fn().mockResolvedValue({
        findings: [advisory],
        proofStatus: 'not_requested',
      }),
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'INCONCLUSIVE',
    }));
  });

  it('stores a generic error when hosted checkout fails', async () => {
    const reviewStore = store();
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async () => { throw new Error('sensitive dependency detail'); },
    });

    await handler.handle(reviewRunId);

    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'ERROR',
      summary: expect.not.stringContaining('sensitive'),
    }));
  });

  it('fails a run whose prompt implementation is unavailable', async () => {
    const reviewStore = store({
      claim: vi.fn().mockResolvedValue({
        ...claimed,
        promptVersion: 'removed-prompt-version',
      }),
    });
    const tokens = { getInstallationToken: vi.fn() };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
    });

    await handler.handle(reviewRunId);

    expect(tokens.getInstallationToken).not.toHaveBeenCalled();
    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'ERROR',
    }));
  });


  it('publishes nothing after losing the final lease', async () => {
    const reviewStore = store({ renew: vi.fn().mockResolvedValue(false) });
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens: {
        getInstallationToken: vi.fn().mockResolvedValue({
          token: 'installation-token',
          expiresAt: '2026-09-10T02:00:00.000Z',
        }),
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline: vi.fn().mockResolvedValue(pipelineResult()),
    });

    await expect(handler.handle(reviewRunId)).rejects.toThrow('lease was lost');
    expect(reviewStore.complete).not.toHaveBeenCalled();
  });

  it('skips a run that another worker already owns', async () => {
    const reviewStore = store({ claim: vi.fn().mockResolvedValue(null) });
    const tokens = { getInstallationToken: vi.fn() };
    const handler = createHostedReviewJobHandler({
      store: reviewStore,
      tokens,
      workerId: 'worker-1',
      leaseMs: 60_000,
      proofImage,
    });

    await handler.handle(reviewRunId);

    expect(tokens.getInstallationToken).not.toHaveBeenCalled();
    expect(reviewStore.complete).not.toHaveBeenCalled();
  });
});
