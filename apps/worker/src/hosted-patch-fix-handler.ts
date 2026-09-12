import type {
  PatchFixJob,
  PatchReproofResult,
} from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  createPatchReproofBudget,
  PatchGenerationError,
  restorePublishedPatchCandidate,
  runApprovedPatchReproof,
  WALKZ_PATCH_PROMPT_VERSION,
} from '@walkz/engine';
import {
  SuggestionPublicationError,
  type GitHubInstallationToken,
  type InstallationGitHubSuggestionServiceFactory,
} from '@walkz/github';
import {
  withHostedGitHubCheckout,
  type HostedCheckoutOptions,
} from '@walkz/git';
import type {
  ClaimedPatchFixTarget,
  PatchReproofRecordResult,
} from '@walkz/persistence';
import type { DockerWorkspaceVolume } from '@walkz/sandbox';
import { z } from 'zod';

import type { PatchFixJobHandler } from './patch-fix-queue.js';

const workerOptionsSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
  proofImage: z.string().trim().max(512)
    .regex(/^(?!-)[^\s@]+@sha256:[a-f0-9]{64}$/i),
}).strict();

interface PatchFixLeaseInput {
  proposalId: string;
  workerId: string;
  leaseMs: number;
}

export interface HostedPatchFixStore {
  claim(input: PatchFixLeaseInput): Promise<PatchFixJob | null>;
  renew(input: PatchFixLeaseInput): Promise<boolean>;
  loadTarget(input: {
    proposalId: string;
    workerId: string;
  }): Promise<ClaimedPatchFixTarget | null>;
  latestReproof(proposalId: string): Promise<PatchReproofResult | null>;
  recordReproof(result: PatchReproofResult): Promise<PatchReproofRecordResult>;
  complete(input: {
    proposalId: string;
    workerId: string;
    outcome: 'resolved' | 'unresolved' | 'inconclusive';
  }): Promise<PatchFixJob | null>;
  release(input: { proposalId: string; workerId: string }): Promise<boolean>;
  fail(input: {
    proposalId: string;
    workerId: string;
    failureCode: 'candidate_changed' | 'proof_binding_invalid' |
      'proof_infrastructure_failed' | 'github_publication_failed' |
      'workflow_failed';
  }): Promise<PatchFixJob | null>;
}

export interface HostedPatchFixTokens {
  getInstallationToken(installationId: number): Promise<GitHubInstallationToken>;
}

type Checkout = <T>(
  input: unknown,
  operation: (repositoryRoot: string) => Promise<T>,
  options?: HostedCheckoutOptions,
) => Promise<T>;

export interface HostedPatchFixHandlerOptions {
  store: HostedPatchFixStore;
  tokens: HostedPatchFixTokens;
  github: InstallationGitHubSuggestionServiceFactory;
  workerId: string;
  leaseMs: number;
  proofImage: string;
  workspaceVolume?: DockerWorkspaceVolume;
  checkout?: Checkout;
  runReproof?: typeof runApprovedPatchReproof;
}

function installationNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('GitHub installation ID cannot be represented safely.');
  }
  return parsed;
}

function sanitizedOutput(summary: string) {
  const bounded = Array.from(summary).slice(0, 8_192).join('');
  return {
    summary: bounded,
    originalBytes: Buffer.byteLength(summary, 'utf8'),
    truncated: bounded !== summary,
    redacted: true,
  };
}

function originalExecution(target: ClaimedPatchFixTarget) {
  const common = {
    planDigest: target.proof.planDigest,
    commandDigest: target.proof.commandDigest,
    durationMs: Math.floor(target.proof.durationMs / 2),
    stdout: sanitizedOutput(target.proof.sanitizedSummary),
    stderr: sanitizedOutput(''),
    artifacts: [],
    recordedAt: target.proof.recordedAt.toISOString(),
  };
  return {
    base: {
      ...common,
      revision: 'base' as const,
      sha: target.baseSha,
      outcome: target.proof.baseOutcome,
      exitCode: target.proof.baseExitCode,
    },
    head: {
      ...common,
      durationMs: target.proof.durationMs - common.durationMs,
      revision: 'head' as const,
      sha: target.headSha,
      outcome: target.proof.headOutcome,
      exitCode: target.proof.headExitCode,
    },
  };
}

function startLeaseHeartbeat(
  store: HostedPatchFixStore,
  lease: PatchFixLeaseInput,
  controller: AbortController,
): { stop(): Promise<boolean> } {
  const intervalMs = Math.max(1_000, Math.floor(lease.leaseMs / 3));
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const schedule = (): void => {
    timer = setTimeout(() => {
      pending = store.renew(lease)
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

export function createHostedPatchFixJobHandler(
  input: HostedPatchFixHandlerOptions,
): PatchFixJobHandler {
  const options = workerOptionsSchema.parse({
    workerId: input.workerId,
    leaseMs: input.leaseMs,
    proofImage: input.proofImage,
  });
  const checkout = input.checkout ?? withHostedGitHubCheckout;
  const runReproof = input.runReproof ?? runApprovedPatchReproof;

  return {
    async handle(proposalId) {
      const lease = { proposalId, workerId: options.workerId, leaseMs: options.leaseMs };
      const job = await input.store.claim(lease);
      if (job === null) return;
      const controller = new AbortController();
      const heartbeat = startLeaseHeartbeat(input.store, lease, controller);
      let failure: Parameters<HostedPatchFixStore['fail']>[0]['failureCode'] | null = null;
      let retry = false;
      let retryCause: unknown;
      let phase: 'loading' | 'binding' | 'candidate' | 'reproof' |
        'completion' = 'loading';
      try {
        const target = await input.store.loadTarget({
          proposalId,
          workerId: options.workerId,
        });
        if (target === null || target.job.promptVersion !== WALKZ_PATCH_PROMPT_VERSION) {
          failure = 'proof_binding_invalid';
          return;
        }
        if (
          target.proposal.githubReference === null ||
          target.proposal.githubReference.kind !== 'review_comment'
        ) {
          failure = 'proof_binding_invalid';
          return;
        }
        const githubReference = target.proposal.githubReference.value;
        phase = 'binding';
        const binding = bindPatchProofToRepositoryCommand({
          reviewRunId: target.reviewRunId,
          findingFingerprint: target.finding.fingerprint,
          baseSha: target.baseSha,
          headSha: target.headSha,
          commandDigest: target.proof.commandDigest,
          containerImage: options.proofImage,
          config: target.config,
        });
        if (
          binding.planDigest !== target.job.proofPlanDigest ||
          binding.planDigest !== target.proof.planDigest
        ) {
          failure = 'proof_binding_invalid';
          return;
        }

        let reproof = await input.store.latestReproof(proposalId);
        if (
          reproof !== null &&
          (reproof.patchHash !== target.proposal.patchHash ||
            reproof.headSha !== target.headSha)
        ) {
          failure = 'proof_binding_invalid';
          return;
        }
        if (reproof !== null && reproof.outcome !== 'resolved') {
          const completed = await input.store.complete({
            proposalId,
            workerId: options.workerId,
            outcome: reproof.outcome,
          });
          if (completed === null) throw new Error('Patch fix lease was lost before completion.');
          return;
        }
        if (reproof !== null && target.proposal.githubReference !== null) {
          const completed = await input.store.complete({
            proposalId,
            workerId: options.workerId,
            outcome: 'resolved',
          });
          if (completed === null) throw new Error('Patch fix lease was lost before completion.');
          return;
        }

        const [installation, service] = await Promise.all([
          input.tokens.getInstallationToken(installationNumber(target.installationId)),
          input.github.forInstallation(target.installationId),
        ]);
        phase = 'candidate';
        let candidate;
        try {
          const published = await service.loadPublishedSuggestion({
            owner: target.owner,
            repository: target.repository,
            pullRequestNumber: target.pullRequestNumber,
            proposalId: target.proposal.id,
            headSha: target.headSha,
            patchHash: target.proposal.patchHash,
            githubReference,
          });
          const headFile = await service.loadHeadFile({
            owner: target.owner,
            repository: target.repository,
            pullRequestNumber: target.pullRequestNumber,
            headSha: target.headSha,
            path: published.path,
          });
          candidate = restorePublishedPatchCandidate({
            reviewRunId: target.reviewRunId,
            findingId: target.findingId,
            baseSha: target.baseSha,
            headSha: target.headSha,
            currentHeadSha: headFile.currentHeadSha,
            expectedPatchHash: target.proposal.patchHash,
            path: published.path,
            startLine: published.startLine,
            endLine: published.endLine,
            replacement: published.replacement,
            headFile: { path: headFile.path, content: headFile.content },
          });
        } catch (error) {
          if (error instanceof PatchGenerationError) {
            failure = error.code === 'stale_head'
              ? 'proof_binding_invalid'
              : 'candidate_changed';
            return;
          }
          if (error instanceof SuggestionPublicationError) {
            if (error.code === 'stale_head') {
              failure = 'proof_binding_invalid';
              return;
            }
            if (error.code === 'invalid_input' || error.code === 'marker_conflict') {
              failure = 'candidate_changed';
              return;
            }
          }
          throw error;
        }

        if (reproof === null) {
          phase = 'reproof';
          const run = await checkout({
            owner: target.owner,
            repository: target.repository,
            baseSha: target.baseSha,
            headSha: target.headSha,
            githubToken: installation.token,
          }, async (repositoryRoot) => runReproof({
            attempt: target.job.attempt,
            finding: target.finding,
            proposal: target.proposal,
            candidate,
            proofPlan: binding.plan,
            originalExecution: originalExecution(target),
            regressionPlans: binding.regressionPlans,
          }, {
            repositoryRoot,
            authorization: binding.authorization,
            budget: createPatchReproofBudget(binding),
            githubToken: installation.token,
            workspaceLimits: {
              maxFiles: 20_000,
              maxBytes: 256 * 1_024 * 1_024,
              gitTimeoutMs: 60_000,
            },
            signal: controller.signal,
            ...(input.workspaceVolume === undefined
              ? {}
              : {
                  temporaryRoot: input.workspaceVolume.root,
                  docker: { workspaceVolume: input.workspaceVolume },
                }),
          }), {
            signal: controller.signal,
            ...(input.workspaceVolume === undefined
              ? {}
              : { temporaryRoot: input.workspaceVolume.root }),
          });
          const recorded = await input.store.recordReproof(run.result);
          if (recorded.outcome === 'conflict' || recorded.result === null) {
            failure = 'proof_binding_invalid';
            return;
          }
          reproof = recorded.result;
        }

        phase = 'completion';
        const completed = await input.store.complete({
          proposalId,
          workerId: options.workerId,
          outcome: reproof.outcome,
        });
        if (completed === null) throw new Error('Patch fix lease was lost before completion.');
      } catch (error) {
        retryCause = error;
        if (phase === 'binding') {
          failure = 'proof_binding_invalid';
        } else if (controller.signal.aborted) {
          retry = true;
        } else if (job.attempt < 5) {
          retry = true;
        } else {
          failure = phase === 'reproof'
            ? 'proof_infrastructure_failed'
            : 'workflow_failed';
        }
      } finally {
        const leaseOwned = await heartbeat.stop();
        if (!leaseOwned) retry = true;
        if (failure !== null && leaseOwned) {
          await input.store.fail({
            proposalId,
            workerId: options.workerId,
            failureCode: failure,
          });
        } else if (retry && leaseOwned) {
          await input.store.release({ proposalId, workerId: options.workerId });
        }
      }
      if (retry) {
        throw new Error(
          'Patch fix will be retried.',
          retryCause instanceof Error ? { cause: retryCause } : undefined,
        );
      }
    },
  };
}
