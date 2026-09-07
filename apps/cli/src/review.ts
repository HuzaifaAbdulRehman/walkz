import type {
  ProviderAccessResult,
  ProviderAdapter,
} from '@walkz/contracts';
import {
  hashWalkzConfig,
  runLocalReviewPipeline,
  type LocalReviewPipelineResult,
} from '@walkz/engine';
import {
  locateRepositoryRoot,
  resolveGitReferences,
} from '@walkz/git';
import { createGroqProvider } from '@walkz/providers';
import type { CommandApprovalRequester } from '@walkz/sandbox';

import { loadWalkzConfigAtRevision } from './config.js';
import {
  mapVerdictToExitCode,
  renderJsonReport,
  renderTerminalReport,
} from './review-output.js';

export interface ReviewOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  staged?: boolean;
  noModel?: boolean;
  json?: boolean;
  provider?: ProviderAdapter;
  requestCommandApproval?: CommandApprovalRequester;
  onProviderAccess?: (
    access: ProviderAccessResult,
  ) => void | Promise<void>;
}

export interface ReviewResult {
  exitCode: 0 | 1 | 2 | 3;
  output: string;
  review: LocalReviewPipelineResult;
}

function runDurationMs(
  commandCount: number,
  commandTimeoutMs: number,
): number {
  return Math.min(
    60 * 60 * 1_000,
    Math.max(1, commandCount) * commandTimeoutMs + 120_000,
  );
}

export async function runReview(
  options: ReviewOptions,
): Promise<ReviewResult> {
  const repositoryRoot = await locateRepositoryRoot(options.cwd);
  const staged = options.staged === true;
  const bootstrapReferences = await resolveGitReferences(repositoryRoot, {
    staged,
  });
  const bootstrapConfig = await loadWalkzConfigAtRevision(
    repositoryRoot,
    bootstrapReferences.guidanceSha,
  );
  const trustedReferences =
    !staged && bootstrapConfig.baseBranch !== null
      ? await resolveGitReferences(repositoryRoot, {
          baseRef: bootstrapConfig.baseBranch,
        })
      : bootstrapReferences;
  const config = await loadWalkzConfigAtRevision(
    repositoryRoot,
    trustedReferences.guidanceSha,
  );
  if (config.baseBranch !== bootstrapConfig.baseBranch) {
    throw new Error(
      'The trusted base revisions disagree on the configured base branch.',
    );
  }
  const environment = options.environment ?? process.env;
  const noModel = options.noModel === true;
  const apiKey = environment.GROQ_API_KEY?.trim();
  const provider =
    noModel
      ? undefined
      : options.provider ??
        (apiKey === undefined || apiKey.length === 0
          ? undefined
          : createGroqProvider({ apiKey }));
  const review = await runLocalReviewPipeline({
    request: {
      repositoryRoot,
      baseRef: config.baseBranch,
      headRef: staged ? 'INDEX' : 'HEAD',
      trigger: staged ? 'staged' : 'local',
      configVersion: config.schemaVersion,
      configHash: hashWalkzConfig(config),
      runBudget: {
        maxDurationMs: runDurationMs(
          config.commands.length,
          config.commandTimeoutMs,
        ),
        maxModelTokens: noModel ? 0 : config.tokenBudget,
        maxProofAttempts: 0,
      },
      callerCapabilities: {
        canRunCommands: true,
        canUseModel: !noModel,
        canWriteFiles: false,
      },
    },
    config,
    ...(provider !== undefined && { provider }),
    ...(options.requestCommandApproval !== undefined && {
      requestCommandApproval: options.requestCommandApproval,
    }),
    ...(options.onProviderAccess !== undefined && {
      onProviderAccess: options.onProviderAccess,
    }),
  });
  const verdict = review.decision.verdict;
  return {
    exitCode: mapVerdictToExitCode(verdict),
    output:
      options.json === true
        ? renderJsonReport(review)
        : renderTerminalReport(review),
    review,
  };
}
