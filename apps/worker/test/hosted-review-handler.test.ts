import { createDefaultWalkzConfig } from '@walkz/contracts';
import { hashWalkzConfig } from '@walkz/engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createHostedReviewJobHandler,
  type HostedReviewStore,
} from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const repositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
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
  promptVersion: 'walkz-review-v1',
  status: 'collecting_context' as const,
};

function store(overrides: Partial<HostedReviewStore> = {}): HostedReviewStore {
  return {
    claim: vi.fn().mockResolvedValue(claimed),
    renew: vi.fn().mockResolvedValue(true),
    loadCredential: vi.fn().mockResolvedValue('groq-key'),
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

describe('hosted review job handler', () => {
  it('reviews exact revisions and stores the terminal outcome', async () => {
    const reviewStore = store();
    const checkout = vi.fn(async (_input, operation) => operation('C:/temp/repo'));
    const provider = { name: 'groq' };
    const createProvider = vi.fn().mockReturnValue(provider);
    const runPipeline = vi.fn().mockResolvedValue(pipelineResult());
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
      checkout,
      createProvider,
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
          canRunCommands: false,
          canUseModel: true,
          canWriteFiles: false,
        },
      }),
      provider,
    }));
    expect(reviewStore.complete).toHaveBeenCalledWith(expect.objectContaining({
      reviewRunId,
      workerId: 'worker-1',
      verdict: 'SHIP',
      baseSha,
      headSha,
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
      checkout: async (_input, operation) => operation('C:/temp/repo'),
      runPipeline,
    });

    await handler.handle(reviewRunId);

    expect(runPipeline.mock.calls[0]?.[0]).not.toHaveProperty('provider');
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
    });

    await handler.handle(reviewRunId);

    expect(tokens.getInstallationToken).not.toHaveBeenCalled();
    expect(reviewStore.complete).not.toHaveBeenCalled();
  });
});
