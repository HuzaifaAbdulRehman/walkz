import type {
  ProviderAccessResult,
  ProviderModel,
  ProviderRequestOptions,
} from '@walkz/contracts';
import { z } from 'zod';

import { ProviderError } from './errors.js';
import {
  requestGroqJson,
  type GroqHttpOptions,
} from './http.js';

const GROQ_DATA_CONTROLS_URL = 'https://console.groq.com/settings/data-controls';
const GROQ_PRIVACY_NOTICE =
  'Walkz sends bounded repository context to Groq for review. Groq says inference inputs and outputs are not retained by default, but temporary logging may apply unless Zero Data Retention is enabled. Check Groq Data Controls before reviewing private code.';

export const GROQ_STRICT_MODEL_PREFERENCE = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
] as const;

const strictModelIds = new Set<string>(GROQ_STRICT_MODEL_PREFERENCE);
const groqModelSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    active: z.boolean(),
    context_window: z.number().int().positive().nullable().optional(),
    max_completion_tokens: z.number().int().positive().nullable().optional(),
  })
  .passthrough();
const groqModelsResponseSchema = z
  .object({
    data: z.array(groqModelSchema).max(1_000),
  })
  .passthrough();

export interface GroqAccessOptions extends ProviderRequestOptions {
  apiKey: string;
  requestedModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

function invalidModel(message: string): ProviderError {
  return new ProviderError({
    code: 'model_unavailable',
    message,
    retryable: false,
    status: null,
    retryAfterMs: null,
  });
}

function invalidModelsResponse(cause: unknown): ProviderError {
  return new ProviderError(
    {
      code: 'invalid_response',
      message: 'Groq returned an invalid model list.',
      retryable: false,
      status: 200,
      retryAfterMs: null,
    },
    cause instanceof Error ? { cause } : undefined,
  );
}

function httpOptions(options: GroqAccessOptions): GroqHttpOptions {
  return {
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

export async function discoverGroqModels(
  options: GroqAccessOptions,
): Promise<ProviderModel[]> {
  const response = await requestGroqJson(
    { method: 'GET', path: '/openai/v1/models' },
    httpOptions(options),
  );
  let parsed: z.infer<typeof groqModelsResponseSchema>;
  try {
    parsed = groqModelsResponseSchema.parse(response.data);
  } catch (error) {
    throw invalidModelsResponse(error);
  }

  return parsed.data.map((model) => ({
    id: model.id,
    active: model.active,
    contextWindow: model.context_window ?? null,
    maxCompletionTokens: model.max_completion_tokens ?? null,
    supportsStrictStructuredOutput: strictModelIds.has(model.id),
  }));
}

function selectModel(models: ProviderModel[], requestedModel: string): string {
  if (requestedModel === 'auto') {
    const available = new Set(
      models
        .filter((model) => model.active && model.supportsStrictStructuredOutput)
        .map((model) => model.id),
    );
    const selected = GROQ_STRICT_MODEL_PREFERENCE.find((id) => available.has(id));
    if (selected === undefined) {
      throw invalidModel(
        'Groq has no active model that supports strict structured output.',
      );
    }
    return selected;
  }

  const selected = models.find((model) => model.id === requestedModel);
  if (
    selected === undefined ||
    !selected.active ||
    !selected.supportsStrictStructuredOutput
  ) {
    throw invalidModel(
      'The selected Groq model is unavailable or lacks strict structured output.',
    );
  }
  return selected.id;
}

export async function validateProviderAccess(
  options: GroqAccessOptions,
): Promise<ProviderAccessResult> {
  const requestedModel = options.requestedModel?.trim() || 'auto';
  const models = await discoverGroqModels(options);
  return {
    provider: 'groq',
    selectedModel: selectModel(models, requestedModel),
    models,
    privacyNotice: GROQ_PRIVACY_NOTICE,
    dataControlsUrl: GROQ_DATA_CONTROLS_URL,
  };
}
