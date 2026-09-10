import type { ProviderAdapter, ReviewVerdict } from '@walkz/contracts';
import {
  runLocalReviewPipeline,
  WALKZ_REVIEW_PROMPT_VERSION,
  type LocalReviewPipelineResult,
} from '@walkz/engine';
import type { GitHubInstallationToken } from '@walkz/github';
import {
  collectReviewContext,
  resolveGitReferences,
  withHostedGitHubCheckout,
  type CollectReviewContextOptions,
  type HostedCheckoutOptions,
  type ResolveGitReferencesOptions,
  type ResolvedGitReferences,
  type ReviewContext,
} from '@walkz/git';
import type {
  ClaimedHostedReviewRun,
  CompletedHostedReviewRun,
} from '@walkz/persistence';
import { createGroqProvider } from '@walkz/providers';
import { z } from 'zod';

import type { ReviewJobHandler } from './review-queue.js';

const workerOptionsSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
}).strict();

interface HostedResultFinding {
  fingerprint: string;
  category: 'correctness' | 'security' | 'performance' | 'reliability' | 'maintainability';
  path: string;
  startLine: number;
  endLine: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  lifecycleStatus: 'proposed' | 'challenged' | 'proving' | 'verified' |
    'supported' | 'unverified' | 'dismissed' | 'fixed';
  evidenceLevel: 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED';
  advisoryConfidence: number;
  claim: string;
  failureMechanism: string;
  suggestedProof: string;
}

interface HostedReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: HostedResultFinding[];
}

export interface HostedReviewStore {
  claim(input: {
    reviewRunId: string;
    workerId: string;
    leaseMs: number;
  }): Promise<ClaimedHostedReviewRun | null>;
  renew(input: {
    reviewRunId: string;
    workerId: string;
    leaseMs: number;
  }): Promise<boolean>;
  loadCredential(input: {
    repositoryId: string;
    provider: string;
  }): Promise<string | null>;
  complete(input: {
    reviewRunId: string;
    workerId: string;
    baseSha: string;
    headSha: string;
    verdict: ReviewVerdict;
    summary: string;
    findings: HostedResultFinding[];
  }): Promise<CompletedHostedReviewRun>;
}

export interface HostedInstallationTokens {
  getInstallationToken(installationId: number): Promise<GitHubInstallationToken>;
}

type Checkout = <T>(
  input: unknown,
  operation: (repositoryRoot: string) => Promise<T>,
  options?: HostedCheckoutOptions,
) => Promise<T>;

export interface HostedReviewHandlerOptions {
  store: HostedReviewStore;
  tokens: HostedInstallationTokens;
  workerId: string;
  leaseMs: number;
  checkout?: Checkout;
  collectContext?: (
    repositoryRoot: string,
    references: ResolvedGitReferences,
    options: CollectReviewContextOptions,
  ) => Promise<ReviewContext>;
  createProvider?: (apiKey: string) => ProviderAdapter;
  resolveReferences?: (
    repositoryRoot: string,
    options: ResolveGitReferencesOptions,
  ) => Promise<ResolvedGitReferences>;
  runPipeline?: typeof runLocalReviewPipeline;
}

function summaryFor(verdict: ReviewVerdict): string {
  switch (verdict) {
    case 'SHIP':
      return 'Walkz reviewed the exact pull request diff and found no blocking evidence.';
    case 'FIX':
      return 'Walkz found blocking evidence that should be fixed before merge.';
    case 'HUMAN':
      return 'Walkz needs a maintainer to decide an issue that evidence cannot settle.';
    case 'INCONCLUSIVE':
      return 'Walkz could not collect enough evidence to make a safe merge decision.';
    case 'ERROR':
      return 'Walkz could not complete the review because hosted infrastructure failed.';
  }
}

function boundedSummary(value: string): string {
  return Array.from(value).slice(0, 1_024).join('');
}

function resultFromPipeline(result: LocalReviewPipelineResult): HostedReviewResult {
  const verdict = result.decision.verdict;
  return {
    verdict,
    summary: summaryFor(verdict),
    findings: result.run.findings.slice(0, 50).map((finding) => ({
      fingerprint: finding.fingerprint,
      category: finding.category,
      path: finding.file,
      startLine: finding.line,
      endLine: finding.endLine ?? finding.line,
      severity: finding.severity,
      summary: boundedSummary(finding.claim),
      lifecycleStatus: finding.lifecycleStatus,
      evidenceLevel: finding.evidenceLevel,
      advisoryConfidence: finding.advisoryConfidence,
      claim: finding.claim,
      failureMechanism: finding.failureMechanism,
      suggestedProof: finding.suggestedProof,
    })),
  };
}

function infrastructureFailure(): HostedReviewResult {
  return { verdict: 'ERROR', summary: summaryFor('ERROR'), findings: [] };
}

function installationNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('GitHub installation ID cannot be represented safely.');
  }
  return parsed;
}

function startLeaseHeartbeat(
  store: HostedReviewStore,
  input: { reviewRunId: string; workerId: string; leaseMs: number },
  controller: AbortController,
): { stop: () => Promise<boolean> } {
  const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 3));
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  const schedule = (): void => {
    timer = setTimeout(() => {
      pending = store.renew(input)
        .then((renewed) => {
          if (!renewed) {
            lost = true;
            controller.abort();
          }
        })
        .catch(() => {
          lost = true;
          controller.abort();
        })
        .finally(() => {
          if (!stopped) schedule();
        });
      pending.catch(() => undefined);
    }, intervalMs);
    timer.unref();
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await pending;
      return !lost;
    },
  };
}

export function createHostedReviewJobHandler(
  input: HostedReviewHandlerOptions,
): ReviewJobHandler {
  const worker = workerOptionsSchema.parse({
    workerId: input.workerId,
    leaseMs: input.leaseMs,
  });
  const checkout = input.checkout ?? withHostedGitHubCheckout;
  const collectContext = input.collectContext ?? collectReviewContext;
  const createProvider = input.createProvider ?? ((apiKey: string) =>
    createGroqProvider({ apiKey }));
  const runPipeline = input.runPipeline ?? runLocalReviewPipeline;
  const resolveReferences = input.resolveReferences ?? resolveGitReferences;

  return {
    async handle(reviewRunId) {
      const leaseInput = { reviewRunId, ...worker };
      const run = await input.store.claim(leaseInput);
      if (run === null) return;

      const controller = new AbortController();
      const heartbeat = startLeaseHeartbeat(input.store, leaseInput, controller);
      let result: HostedReviewResult;
      try {
        if (run.promptVersion !== WALKZ_REVIEW_PROMPT_VERSION) {
          throw new Error('Review run prompt version is unavailable in this worker.');
        }
        const [installation, credential] = await Promise.all([
          input.tokens.getInstallationToken(installationNumber(run.installationId)),
          input.store.loadCredential({
            repositoryId: run.repositoryId,
            provider: run.provider,
          }),
        ]);
        const provider = credential === null ? undefined : createProvider(credential);
        result = await checkout({
          owner: run.owner,
          repository: run.repository,
          baseSha: run.baseSha,
          headSha: run.headSha,
          githubToken: installation.token,
        }, async (repositoryRoot) => resultFromPipeline(await runPipeline({
          request: {
            repositoryRoot,
            baseRef: 'refs/walkz/base',
            headRef: 'HEAD',
            trigger: 'github',
            configVersion: run.config.schemaVersion,
            configHash: run.configHash,
            runBudget: {
              maxDurationMs: 10 * 60 * 1_000,
              maxModelTokens: run.config.tokenBudget,
              maxProofAttempts: 0,
            },
            callerCapabilities: {
              canRunCommands: false,
              canUseModel: true,
              canWriteFiles: false,
            },
            prNumber: run.pullRequestNumber,
          },
          config: run.config,
          ...(provider === undefined ? {} : { provider }),
          dependencies: {
            collectContext: (root, references, options) => collectContext(
              root,
              references,
              { ...options, githubToken: installation.token },
            ),
            resolveReferences: (root, options) => resolveReferences(
              root,
              { ...options, githubToken: installation.token },
            ),
          },
          runIdFactory: () => run.reviewRunId,
          signal: controller.signal,
        })), { signal: controller.signal });
      } catch {
        if (controller.signal.aborted) {
          await heartbeat.stop();
          throw new Error('Review run lease was lost during execution.');
        }
        result = infrastructureFailure();
      }

      const heartbeatOwned = await heartbeat.stop();
      const finalLeaseOwned = heartbeatOwned && await input.store.renew(leaseInput);
      if (!finalLeaseOwned) {
        throw new Error('Review run lease was lost before completion.');
      }
      await input.store.complete({
        reviewRunId: run.reviewRunId,
        workerId: worker.workerId,
        baseSha: run.baseSha,
        headSha: run.headSha,
        ...result,
      });
    },
  };
}
