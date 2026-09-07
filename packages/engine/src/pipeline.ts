import type {
  DeterministicCheckRun,
  LocalReviewBudget,
  LocalReviewRun,
  LocalVerdictDecision,
  ProviderAdapter,
  ProviderAccessResult,
  RepositoryConfig,
} from '@walkz/contracts';
import {
  collectReviewContext,
  resolveGitReferences,
  type CollectReviewContextOptions,
  type ResolveGitReferencesOptions,
  type ResolvedGitReferences,
  type ReviewContext,
} from '@walkz/git';
import {
  runDeterministicChecks,
  type CommandApprovalRequester,
  type RunDeterministicChecksOptions,
} from '@walkz/sandbox';

import type {
  FindingRejection,
  FindingRejectionReason,
} from './evidence.js';
import {
  cloneProviderStep,
  NO_PROVIDER,
  requiredCheckFailed,
  reviewWithProvider,
  type ProviderReviewStep,
  type ProviderStepFailureCode,
} from './provider-review.js';
import {
  buildReviewBudget,
  createLocalReviewRun,
  type CreateLocalReviewRunOptions,
} from './run.js';
import { adjudicateLocalVerdict } from './verdict.js';

export type {
  FindingRejection,
  FindingRejectionReason,
  ProviderReviewStep,
  ProviderStepFailureCode,
};

export type PipelineFailureStage = 'context' | 'checks';

export interface PipelineFailure {
  stage: PipelineFailureStage;
  message: string;
}

export interface LocalReviewPipelineDependencies {
  resolveReferences?: (
    repositoryRoot: string,
    options: ResolveGitReferencesOptions,
  ) => Promise<ResolvedGitReferences>;
  collectContext?: (
    repositoryRoot: string,
    references: ResolvedGitReferences,
    options: CollectReviewContextOptions,
  ) => Promise<ReviewContext>;
  runChecks?: (
    config: RepositoryConfig,
    repositoryRoot: string,
    options: RunDeterministicChecksOptions,
  ) => Promise<DeterministicCheckRun>;
}

export interface LocalReviewPipelineInput
  extends CreateLocalReviewRunOptions {
  request: unknown;
  config: unknown;
  provider?: ProviderAdapter;
  requestCommandApproval?: CommandApprovalRequester;
  onProviderAccess?: (
    access: ProviderAccessResult,
  ) => void | Promise<void>;
  signal?: AbortSignal;
  dependencies?: LocalReviewPipelineDependencies;
}

export interface LocalReviewPipelineResult {
  run: LocalReviewRun;
  budget: LocalReviewBudget;
  context: ReviewContext | null;
  deterministicChecks: DeterministicCheckRun | null;
  provider: ProviderReviewStep;
  decision: LocalVerdictDecision;
  failure: PipelineFailure | null;
}

function decide(
  run: LocalReviewRun,
  contextStatus: 'complete' | 'incomplete' | 'error',
  checkStatus: 'complete' | 'incomplete' | 'error',
  providerStatus: ProviderReviewStep['status'],
  humanJudgmentRequired: boolean,
): LocalVerdictDecision {
  return adjudicateLocalVerdict({
    contextStatus,
    checkStatus,
    providerStatus,
    proofStatus: 'not_requested',
    findings: run.findings,
    blockingEvidenceLevels: run.config.blockingEvidenceLevels,
    humanJudgmentRequired,
  });
}

function terminalStatus(
  decision: LocalVerdictDecision,
  cancelled: boolean,
): LocalReviewRun['status'] {
  if (cancelled) {
    return 'cancelled';
  }
  if (decision.verdict === 'ERROR') {
    return 'failed';
  }
  if (decision.verdict === 'INCONCLUSIVE') {
    return 'inconclusive';
  }
  if (decision.verdict === 'HUMAN') {
    return 'awaiting_human';
  }
  return 'completed';
}

function completeRun(
  run: LocalReviewRun,
  decision: LocalVerdictDecision,
  clock: (() => Date) | undefined,
  cancelled = false,
): LocalReviewRun {
  const completedAt = clock?.() ?? new Date();
  if (
    Number.isNaN(completedAt.getTime()) ||
    completedAt.getTime() < Date.parse(run.startedAt)
  ) {
    throw new Error('Review completion time must follow its start time.');
  }
  return {
    ...run,
    status: terminalStatus(decision, cancelled),
    verdict: decision.verdict,
    completedAt: completedAt.toISOString(),
  };
}

function result(
  run: LocalReviewRun,
  budget: LocalReviewBudget,
  context: ReviewContext | null,
  checks: DeterministicCheckRun | null,
  provider: ProviderReviewStep,
  decision: LocalVerdictDecision,
  failure: PipelineFailure | null,
  clock: (() => Date) | undefined,
  cancelled = false,
): LocalReviewPipelineResult {
  return {
    run: completeRun(run, decision, clock, cancelled),
    budget,
    context,
    deterministicChecks: checks,
    provider: cloneProviderStep(provider),
    decision,
    failure,
  };
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'cancelled')
  );
}

export async function runLocalReviewPipeline(
  input: LocalReviewPipelineInput,
): Promise<LocalReviewPipelineResult> {
  let run = createLocalReviewRun(input.request, input.config, input);
  const budget = buildReviewBudget(
    run.request,
    run.config,
    Date.parse(run.startedAt),
  );
  const deadlineController = new AbortController();
  let deadlineReached = false;
  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    deadlineController.abort();
  }, budget.maxDurationMs);
  deadlineTimer.unref();
  const signal =
    input.signal === undefined
      ? deadlineController.signal
      : AbortSignal.any([input.signal, deadlineController.signal]);
  const resolveReferences =
    input.dependencies?.resolveReferences ?? resolveGitReferences;
  const collectContext =
    input.dependencies?.collectContext ?? collectReviewContext;
  const runChecks =
    input.dependencies?.runChecks ?? runDeterministicChecks;

  try {
    let context: ReviewContext;
    try {
      const references = await resolveReferences(run.request.repositoryRoot, {
        baseRef: run.request.baseRef ?? run.config.baseBranch,
        staged: run.request.trigger === 'staged',
        signal,
      });
      context = await collectContext(
        run.request.repositoryRoot,
        references,
        {
          fileBudget: run.config.fileBudget,
          diffBudgetBytes: run.config.diffBudgetBytes,
          include: run.config.paths.include,
          exclude: run.config.paths.exclude,
          signal,
        },
      );
    } catch (error) {
      const cancelled = isCancelled(error, signal);
      const timedOut = deadlineReached && input.signal?.aborted !== true;
      const decision = decide(
        run,
        cancelled ? 'incomplete' : 'error',
        'incomplete',
        'not_requested',
        false,
      );
      return result(
        run,
        budget,
        null,
        null,
        NO_PROVIDER,
        decision,
        {
          stage: 'context',
          message: timedOut
            ? 'The review deadline expired while collecting context.'
            : cancelled
              ? 'Context collection was cancelled.'
              : 'Repository context could not be collected.',
        },
        input.clock,
        cancelled && !timedOut,
      );
    }

    let checks: DeterministicCheckRun;
    try {
      checks = run.request.callerCapabilities.canRunCommands
        ? await runChecks(run.config, run.request.repositoryRoot, {
            ...(input.requestCommandApproval !== undefined && {
              requestApproval: input.requestCommandApproval,
            }),
            signal,
          })
        : {
            approval: { status: 'unavailable', source: 'none' },
            plannedCount: run.config.commands.length,
            checks: [],
            status: run.config.commands.some((command) => command.required)
              ? 'incomplete'
              : 'complete',
          };
    } catch (error) {
      const cancelled = isCancelled(error, signal);
      const timedOut = deadlineReached && input.signal?.aborted !== true;
      const decision = decide(
        run,
        context.coverage.complete ? 'complete' : 'incomplete',
        cancelled ? 'incomplete' : 'error',
        'not_requested',
        false,
      );
      return result(
        run,
        budget,
        context,
        null,
        NO_PROVIDER,
        decision,
        {
          stage: 'checks',
          message: timedOut
            ? 'The review deadline expired while running checks.'
            : cancelled
              ? 'Repository checks were cancelled.'
              : 'Repository checks could not be completed.',
        },
        input.clock,
        cancelled && !timedOut,
      );
    }

    if (checks.status !== 'complete') {
      const decision = decide(
        run,
        context.coverage.complete ? 'complete' : 'incomplete',
        checks.status,
        'not_requested',
        false,
      );
      return result(
        run,
        budget,
        context,
        checks,
        NO_PROVIDER,
        decision,
        null,
        input.clock,
        input.signal?.aborted === true,
      );
    }

    const providerReview = await reviewWithProvider(
      run,
      context,
      checks,
      budget,
      input.provider,
      signal,
      (input.clock?.() ?? new Date()).toISOString(),
      input.onProviderAccess,
    );
    if (
      deadlineReached &&
      providerReview.step.failureCode === 'cancelled'
    ) {
      providerReview.step.failureCode = 'budget_exhausted';
    }
    run = { ...run, findings: providerReview.findings };
    const contextStatus =
      context.coverage.complete && !providerReview.step.promptTruncated
        ? 'complete'
        : 'incomplete';
    const decision = decide(
      run,
      contextStatus,
      checks.status,
      providerReview.step.status,
      requiredCheckFailed(checks),
    );
    return result(
      run,
      budget,
      context,
      checks,
      providerReview.step,
      decision,
      null,
      input.clock,
      providerReview.cancelled && !deadlineReached,
    );
  } finally {
    clearTimeout(deadlineTimer);
  }
}
