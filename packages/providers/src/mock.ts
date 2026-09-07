import {
  parseModelReviewResponse,
  type ProviderAccessResult,
  type ProviderAdapter,
  type ProviderModel,
  type ProviderRequestOptions,
  type ProviderUsage,
  type StructuredReviewRequest,
  type StructuredReviewResult,
} from '@walkz/contracts';

import {
  ProviderCancelledError,
  ProviderError,
  toProviderError,
  type ProviderFailure,
} from './errors.js';
import { WALKZ_REVIEW_SCHEMA_VERSION } from './groq.js';

const MOCK_PRIVACY_NOTICE =
  'The mock provider runs in this process and sends no data over the network.';
const DEFAULT_MODEL: ProviderModel = {
  id: 'mock/reviewer',
  active: true,
  contextWindow: 131_072,
  maxCompletionTokens: 32_768,
  supportsStrictStructuredOutput: true,
};
const EMPTY_USAGE: ProviderUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  latencyMs: 0,
  rateLimit: {
    retryAfterMs: null,
    remainingRequests: null,
    remainingTokens: null,
    resetRequests: null,
    resetTokens: null,
  },
};

export type MockProviderOutcome =
  | {
      type: 'review';
      review: unknown;
      usage?: ProviderUsage;
      requestId?: string | null;
    }
  | {
      type: 'error';
      failure: ProviderFailure;
    };

export interface MockProviderOptions {
  models?: readonly ProviderModel[];
  outcomes?: readonly MockProviderOutcome[];
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw toProviderError(new ProviderCancelledError());
  }
}

function cloneModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models.map((model) => ({ ...model }));
}

function modelFailure(message: string): ProviderError {
  return new ProviderError({
    code: 'model_unavailable',
    message,
    retryable: false,
    status: null,
    retryAfterMs: null,
  });
}

function invalidResponse(message: string): ProviderError {
  return new ProviderError({
    code: 'invalid_response',
    message,
    retryable: false,
    status: null,
    retryAfterMs: null,
  });
}

function selectModel(models: readonly ProviderModel[], requestedModel: string) {
  if (requestedModel === 'auto') {
    const selected = models.find(
      (model) => model.active && model.supportsStrictStructuredOutput,
    );
    if (selected === undefined) {
      throw modelFailure('The mock provider has no active strict model.');
    }
    return selected.id;
  }
  const selected = models.find(
    (model) =>
      model.id === requestedModel &&
      model.active &&
      model.supportsStrictStructuredOutput,
  );
  if (selected === undefined) {
    throw modelFailure('The selected mock model is unavailable.');
  }
  return selected.id;
}

function cloneUsage(usage: ProviderUsage): ProviderUsage {
  return { ...usage, rateLimit: { ...usage.rateLimit } };
}

export function createMockProvider(
  options: MockProviderOptions = {},
): ProviderAdapter {
  const models = cloneModels(options.models ?? [DEFAULT_MODEL]);
  const outcomes = [...(options.outcomes ?? [])];
  let requestNumber = 0;

  const listModels = async (
    requestOptions: ProviderRequestOptions = {},
  ): Promise<ProviderModel[]> => {
    cancelled(requestOptions.signal);
    return cloneModels(models);
  };

  const validateAccess = async (
    requestedModel: string,
    requestOptions: ProviderRequestOptions = {},
  ): Promise<ProviderAccessResult> => {
    cancelled(requestOptions.signal);
    return {
      provider: 'mock',
      selectedModel: selectModel(models, requestedModel.trim() || 'auto'),
      models: cloneModels(models),
      privacyNotice: MOCK_PRIVACY_NOTICE,
      dataControlsUrl: null,
    };
  };

  const requestStructuredReview = async (
    request: StructuredReviewRequest,
    requestOptions: ProviderRequestOptions = {},
  ): Promise<StructuredReviewResult> => {
    cancelled(requestOptions.signal);
    const model = selectModel(models, request.model);
    const outcome = outcomes.shift();
    if (outcome === undefined) {
      throw invalidResponse('No mock provider outcome is queued.');
    }
    if (outcome.type === 'error') {
      throw new ProviderError(outcome.failure);
    }

    let review;
    try {
      review = parseModelReviewResponse(outcome.review);
    } catch {
      throw invalidResponse('The queued mock provider response is invalid.');
    }
    requestNumber += 1;
    return {
      provider: 'mock',
      model,
      promptVersion: request.promptVersion,
      schemaVersion: WALKZ_REVIEW_SCHEMA_VERSION,
      review,
      usage: cloneUsage(outcome.usage ?? EMPTY_USAGE),
      requestId:
        outcome.requestId === undefined
          ? 'mock-request-' + requestNumber
          : outcome.requestId,
    };
  };

  return { name: 'mock', listModels, validateAccess, requestStructuredReview };
}
