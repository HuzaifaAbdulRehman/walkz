import type {
  DeterministicCheckRun,
  Finding,
  LocalReviewBudget,
  LocalReviewRun,
  ProviderAdapter,
  ProviderUsage,
  StructuredReviewResult,
} from '@walkz/contracts';
import type { ReviewContext } from '@walkz/git';

import {
  normalizeProviderFindings,
  type FindingRejection,
} from './evidence.js';
import { buildReviewPrompt } from './prompt.js';

export type ProviderStepFailureCode =
  | 'not_configured'
  | 'budget_exhausted'
  | 'access_failed'
  | 'request_failed'
  | 'invalid_response'
  | 'cancelled';

export interface ProviderReviewStep {
  status: 'complete' | 'not_requested' | 'incomplete';
  attempted: boolean;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  usage: ProviderUsage | null;
  requestId: string | null;
  promptTruncated: boolean;
  rejectedFindings: FindingRejection[];
  failureCode: ProviderStepFailureCode | null;
}

export const NO_PROVIDER: ProviderReviewStep = {
  status: 'not_requested',
  attempted: false,
  provider: null,
  model: null,
  promptVersion: null,
  schemaVersion: null,
  usage: null,
  requestId: null,
  promptTruncated: false,
  rejectedFindings: [],
  failureCode: null,
};

export function cloneProviderStep(
  step: ProviderReviewStep,
): ProviderReviewStep {
  return {
    ...step,
    rejectedFindings: [...step.rejectedFindings],
    usage:
      step.usage === null
        ? null
        : { ...step.usage, rateLimit: { ...step.usage.rateLimit } },
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

function incompleteProvider(
  provider: ProviderAdapter | undefined,
  failureCode: ProviderStepFailureCode,
  attempted: boolean,
): ProviderReviewStep {
  return {
    ...NO_PROVIDER,
    status: 'incomplete',
    attempted,
    provider: provider?.name ?? null,
    failureCode,
  };
}

export async function reviewWithProvider(
  run: LocalReviewRun,
  context: ReviewContext,
  checks: DeterministicCheckRun,
  budget: LocalReviewBudget,
  provider: ProviderAdapter | undefined,
  signal: AbortSignal,
  recordedAt: string,
): Promise<{
  step: ProviderReviewStep;
  findings: Finding[];
  cancelled: boolean;
}> {
  if (
    !run.request.callerCapabilities.canUseModel ||
    context.diff.trim().length === 0
  ) {
    return {
      step: cloneProviderStep(NO_PROVIDER),
      findings: [],
      cancelled: false,
    };
  }
  if (provider === undefined) {
    return {
      step: incompleteProvider(undefined, 'not_configured', false),
      findings: [],
      cancelled: false,
    };
  }
  if (budget.maxModelTokens < 1) {
    return {
      step: incompleteProvider(provider, 'budget_exhausted', false),
      findings: [],
      cancelled: false,
    };
  }

  let selectedModel: string;
  let maxCompletionTokens: number | null = null;
  try {
    const access = await provider.validateAccess(run.config.provider.model, {
      signal,
    });
    selectedModel = access.selectedModel;
    maxCompletionTokens =
      access.models.find((model) => model.id === selectedModel)
        ?.maxCompletionTokens ?? null;
  } catch (error) {
    const cancelled = isCancelled(error, signal);
    return {
      step: incompleteProvider(
        provider,
        cancelled ? 'cancelled' : 'access_failed',
        true,
      ),
      findings: [],
      cancelled,
    };
  }

  let prompt;
  try {
    prompt = buildReviewPrompt(context, checks, budget, {
      model: selectedModel,
      maxCompletionTokens,
    });
  } catch (error) {
    return {
      step: incompleteProvider(
        provider,
        error instanceof RangeError
          ? 'budget_exhausted'
          : 'invalid_response',
        false,
      ),
      findings: [],
      cancelled: false,
    };
  }

  let providerResult: StructuredReviewResult;
  try {
    providerResult = await provider.requestStructuredReview(prompt, {
      signal,
    });
  } catch (error) {
    const cancelled = isCancelled(error, signal);
    return {
      step: {
        ...incompleteProvider(
          provider,
          cancelled ? 'cancelled' : 'request_failed',
          true,
        ),
        model: selectedModel,
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [],
      cancelled,
    };
  }

  const invalidEnvelope =
    providerResult === null ||
    typeof providerResult !== 'object' ||
    providerResult.provider !== provider.name ||
    providerResult.model !== selectedModel ||
    providerResult.promptVersion !== prompt.promptVersion ||
    typeof providerResult.schemaVersion !== 'string' ||
    providerResult.schemaVersion.trim().length === 0;
  if (invalidEnvelope) {
    return {
      step: {
        ...incompleteProvider(provider, 'invalid_response', true),
        model: selectedModel,
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [],
      cancelled: false,
    };
  }

  let normalized: ReturnType<typeof normalizeProviderFindings>;
  try {
    normalized = normalizeProviderFindings(
      providerResult.review,
      context.lineIndex,
      checks,
      recordedAt,
    );
  } catch {
    return {
      step: {
        ...incompleteProvider(provider, 'invalid_response', true),
        model: selectedModel,
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [],
      cancelled: false,
    };
  }

  return {
    step: {
      status: normalized.invalid ? 'incomplete' : 'complete',
      attempted: true,
      provider: providerResult.provider,
      model: providerResult.model,
      promptVersion: providerResult.promptVersion,
      schemaVersion: providerResult.schemaVersion,
      usage: providerResult.usage,
      requestId: providerResult.requestId,
      promptTruncated: prompt.truncated,
      rejectedFindings: normalized.rejections,
      failureCode: normalized.invalid ? 'invalid_response' : null,
    },
    findings: normalized.findings,
    cancelled: false,
  };
}

export function requiredCheckFailed(
  checks: DeterministicCheckRun,
): boolean {
  return checks.checks.some(
    (check) => check.required && check.execution.outcome === 'failed',
  );
}
