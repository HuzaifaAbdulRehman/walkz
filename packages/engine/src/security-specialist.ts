import type {
  DeterministicCheckRun,
  Finding,
  LocalReviewBudget,
  ProviderAccessResult,
  ProviderAdapter,
  StructuredReviewResult,
} from '@walkz/contracts';
import type { ReviewContext } from '@walkz/git';

import { normalizeProviderFindings } from './evidence.js';
import type { ResolvedPolicyPacks } from './policy-packs.js';
import { buildReviewPrompt } from './prompt.js';
import {
  NO_PROVIDER,
  type ProviderReviewStep,
  type ProviderStepFailureCode,
} from './provider-review.js';

export const NO_SECURITY_SPECIALIST: ProviderReviewStep = {
  ...NO_PROVIDER,
};

export function requiresSecuritySpecialist(
  context: ReviewContext,
  policies: ResolvedPolicyPacks,
): boolean {
  return Object.values(context.risks).some((risk) =>
    risk.reasons.some((reason) => policies.securityRiskReasons.has(reason)));
}

function incomplete(
  provider: ProviderAdapter | undefined,
  failureCode: ProviderStepFailureCode,
  attempted: boolean,
  model: string | null,
): ProviderReviewStep {
  return {
    ...NO_SECURITY_SPECIALIST,
    status: 'incomplete',
    attempted,
    provider: provider?.name ?? null,
    model,
    failureCode,
  };
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error &&
      error.code === 'cancelled');
}

function isInvalidResponse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    error.code === 'invalid_response';
}

export async function runSecuritySpecialist(input: {
  findings: readonly Finding[];
  context: ReviewContext;
  checks: DeterministicCheckRun;
  policies: ResolvedPolicyPacks;
  budget: LocalReviewBudget;
  usedModelTokens: number;
  access: ProviderAccessResult;
  provider: ProviderAdapter | undefined;
  signal: AbortSignal;
  recordedAt: string;
}): Promise<{ step: ProviderReviewStep; findings: Finding[]; cancelled: boolean }> {
  if (!requiresSecuritySpecialist(input.context, input.policies)) {
    return {
      step: { ...NO_SECURITY_SPECIALIST },
      findings: [...input.findings],
      cancelled: false,
    };
  }
  const provider = input.provider;
  const method = provider?.requestStructuredSecurityReview;
  if (provider === undefined || method === undefined) {
    return {
      step: incomplete(input.provider, 'not_configured', false, null),
      findings: [...input.findings],
      cancelled: false,
    };
  }
  const remainingTokens = input.budget.maxModelTokens - input.usedModelTokens;
  if (remainingTokens < 1) {
    return {
      step: incomplete(
        input.provider,
        'budget_exhausted',
        false,
        input.access.selectedModel,
      ),
      findings: [...input.findings],
      cancelled: false,
    };
  }
  const selected = input.access.models.find((model) =>
    model.id === input.access.selectedModel);
  let prompt;
  try {
    prompt = buildReviewPrompt(
      input.context,
      input.checks,
      { ...input.budget, maxModelTokens: remainingTokens },
      {
        model: input.access.selectedModel,
        maxCompletionTokens: selected?.maxCompletionTokens ?? null,
        purpose: 'security',
      },
    );
  } catch {
    return {
      step: incomplete(
        input.provider,
        'budget_exhausted',
        false,
        input.access.selectedModel,
      ),
      findings: [...input.findings],
      cancelled: false,
    };
  }

  let result: StructuredReviewResult;
  try {
    result = await method.call(input.provider, prompt, { signal: input.signal });
  } catch (error) {
    const cancelled = isCancelled(error, input.signal);
    return {
      step: {
        ...incomplete(
          input.provider,
          cancelled
            ? 'cancelled'
            : isInvalidResponse(error)
              ? 'invalid_response'
              : 'request_failed',
          true,
          input.access.selectedModel,
        ),
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [...input.findings],
      cancelled,
    };
  }

  const validEnvelope =
    result !== null &&
    typeof result === 'object' &&
    result.provider === provider.name &&
    result.model === input.access.selectedModel &&
    result.promptVersion === prompt.promptVersion &&
    typeof result.schemaVersion === 'string' &&
    result.schemaVersion.trim().length > 0;
  if (!validEnvelope) {
    return {
      step: {
        ...incomplete(
          input.provider,
          'invalid_response',
          true,
          input.access.selectedModel,
        ),
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [...input.findings],
      cancelled: false,
    };
  }

  let normalized: ReturnType<typeof normalizeProviderFindings>;
  try {
    normalized = normalizeProviderFindings(
      result.review,
      input.context.lineIndex,
      input.checks,
      input.recordedAt,
    );
  } catch {
    return {
      step: {
        ...incomplete(input.provider, 'invalid_response', true, result.model),
        promptVersion: prompt.promptVersion,
        promptTruncated: prompt.truncated,
      },
      findings: [...input.findings],
      cancelled: false,
    };
  }
  const nonSecurity = normalized.findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.category !== 'security');
  if (normalized.invalid || nonSecurity.length > 0) {
    return {
      step: {
        ...incomplete(input.provider, 'invalid_response', true, result.model),
        promptVersion: prompt.promptVersion,
        schemaVersion: result.schemaVersion,
        usage: result.usage,
        requestId: result.requestId,
        promptTruncated: prompt.truncated,
        rejectedFindings: [
          ...normalized.rejections,
          ...nonSecurity.map(({ index }) => ({
            index,
            reason: 'specialist_non_security_finding' as const,
          })),
        ],
      },
      findings: [...input.findings],
      cancelled: false,
    };
  }

  const fingerprints = new Set(input.findings.map((finding) =>
    finding.fingerprint));
  return {
    step: {
      status: 'complete',
      attempted: true,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      schemaVersion: result.schemaVersion,
      usage: result.usage,
      requestId: result.requestId,
      promptTruncated: prompt.truncated,
      rejectedFindings: normalized.rejections,
      failureCode: null,
    },
    findings: [
      ...input.findings,
      ...normalized.findings.filter((finding) =>
        !fingerprints.has(finding.fingerprint)),
    ],
    cancelled: false,
  };
}
