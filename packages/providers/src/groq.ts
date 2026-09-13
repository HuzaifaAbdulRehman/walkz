import type {
  ProviderAdapter,
  ProviderAccessResult,
  ProviderModel,
  ProviderRequestOptions,
  ProviderRateLimit,
  StructuredChallengeRequest,
  StructuredChallengeResult,
  StructuredPatchRequest,
  StructuredPatchResult,
  StructuredReviewRequest,
  StructuredReviewResult,
} from '@walkz/contracts';
import {
  parseModelChallengeResponse,
  parseModelPatchResponse,
  parseModelReviewResponse,
} from '@walkz/contracts';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import {
  ProviderCancelledError,
  ProviderError,
  toProviderError,
} from './errors.js';
import {
  requestGroqJson,
  type GroqHttpOptions,
} from './http.js';
import { calculateRetryDelay } from './retry.js';

const GROQ_DATA_CONTROLS_URL = 'https://console.groq.com/settings/data-controls';
export const WALKZ_REVIEW_SCHEMA_VERSION = 'walkz-review-v1';
export const WALKZ_PATCH_SCHEMA_VERSION = 'walkz-patch-v1';
export const WALKZ_CHALLENGE_SCHEMA_VERSION = 'walkz-challenge-v1';
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

const structuredReviewRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(512),
    systemPrompt: z.string().min(1).max(1_000_000),
    userPrompt: z.string().min(1).max(1_000_000),
    maxOutputTokens: z.number().int().positive().max(131_072),
    promptVersion: z.string().trim().min(1).max(256),
  })
  .strict();

const groqFindingSchema = z
  .object({
    category: z.enum([
      'correctness',
      'security',
      'performance',
      'reliability',
      'maintainability',
    ]),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    file: z.string(),
    line: z.number().int(),
    endLine: z.number().int().nullable(),
    claim: z.string(),
    failureMechanism: z.string(),
    suggestedProof: z.string(),
    confidence: z.number(),
  })
  .strict();
const groqStructuredReviewSchema = z
  .object({ findings: z.array(groqFindingSchema) })
  .strict();
const groqStructuredPatchSchema = z
  .object({
    findingId: z.string(),
    headSha: z.string(),
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    replacement: z.string(),
    approvalRequired: z.boolean(),
  })
  .strict();
const groqStructuredChallengeSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          findingFingerprint: z.string(),
          rationale: z.string(),
          verdict: z.enum(['uphold', 'dispute', 'needs_human']),
        })
        .strict(),
    ),
  })
  .strict();
const groqChatResponseSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    model: z.string().trim().min(1).max(512),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().trim().min(1).max(128),
            message: z
              .object({ content: z.string() })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
    x_groq: z
      .object({ id: z.string().trim().min(1).max(512).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const GROQ_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'correctness',
              'security',
              'performance',
              'reliability',
              'maintainability',
            ],
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
          },
          file: { type: 'string' },
          line: { type: 'integer' },
          endLine: { type: ['integer', 'null'] },
          claim: { type: 'string' },
          failureMechanism: { type: 'string' },
          suggestedProof: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: [
          'category',
          'severity',
          'file',
          'line',
          'endLine',
          'claim',
          'failureMechanism',
          'suggestedProof',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

const GROQ_PATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findingId: { type: 'string' },
    headSha: { type: 'string' },
    path: { type: 'string' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    replacement: { type: 'string' },
    approvalRequired: { type: 'boolean', enum: [true] },
  },
  required: [
    'findingId',
    'headSha',
    'path',
    'startLine',
    'endLine',
    'replacement',
    'approvalRequired',
  ],
  additionalProperties: false,
} as const;

const GROQ_CHALLENGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingFingerprint: { type: 'string' },
          rationale: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['uphold', 'dispute', 'needs_human'],
          },
        },
        required: ['findingFingerprint', 'rationale', 'verdict'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
} as const;

export interface GroqAccessOptions extends ProviderRequestOptions {
  apiKey: string;
  requestedModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export interface GroqProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  monotonicNow?: () => number;
  maxAttempts?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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

function requestFailure(message: string): ProviderError {
  return new ProviderError({
    code: 'invalid_request',
    message,
    retryable: false,
    status: null,
    retryAfterMs: null,
  });
}

function responseFailure(message: string): ProviderError {
  return new ProviderError({
    code: 'invalid_response',
    message,
    retryable: false,
    status: 200,
    retryAfterMs: null,
  });
}

function parseHeaderInteger(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseHeaderText(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value !== null && value.length <= 256 ? value : null;
}

function rateLimitFrom(headers: Headers): ProviderRateLimit {
  return {
    retryAfterMs: null,
    remainingRequests: parseHeaderInteger(
      headers,
      'x-ratelimit-remaining-requests',
    ),
    remainingTokens: parseHeaderInteger(
      headers,
      'x-ratelimit-remaining-tokens',
    ),
    resetRequests: parseHeaderText(headers, 'x-ratelimit-reset-requests'),
    resetTokens: parseHeaderText(headers, 'x-ratelimit-reset-tokens'),
  };
}

function normalizeRequest(request: StructuredReviewRequest): StructuredReviewRequest {
  try {
    return structuredReviewRequestSchema.parse(request);
  } catch {
    throw requestFailure('The structured review request is invalid.');
  }
}

function parseStructuredReview(content: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw responseFailure('Groq returned malformed structured review JSON.');
  }

  let structured: z.infer<typeof groqStructuredReviewSchema>;
  try {
    structured = groqStructuredReviewSchema.parse(decoded);
  } catch {
    throw responseFailure('Groq returned an invalid structured review.');
  }

  return parseModelReviewResponse({
    findings: structured.findings.map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      ...(finding.endLine === null ? {} : { endLine: finding.endLine }),
      claim: finding.claim,
      failureMechanism: finding.failureMechanism,
      suggestedProof: finding.suggestedProof,
      confidence: finding.confidence,
    })),
  });
}

function createRequestBody(request: StructuredReviewRequest): string {
  return JSON.stringify({
    model: request.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    stream: false,
    n: 1,
    max_completion_tokens: request.maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: WALKZ_REVIEW_SCHEMA_VERSION.replaceAll('-', '_'),
        strict: true,
        schema: GROQ_REVIEW_JSON_SCHEMA,
      },
    },
  });
}

function createPatchRequestBody(request: StructuredPatchRequest): string {
  const seed = createHash('sha256')
    .update(request.promptVersion, 'utf8')
    .update('\0', 'utf8')
    .update(request.model, 'utf8')
    .update('\0', 'utf8')
    .update(request.systemPrompt, 'utf8')
    .update('\0', 'utf8')
    .update(request.userPrompt, 'utf8')
    .digest()
    .readUInt32BE(0) & 0x7fff_ffff;
  return JSON.stringify({
    model: request.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    stream: false,
    n: 1,
    seed,
    temperature: 0,
    max_completion_tokens: request.maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: WALKZ_PATCH_SCHEMA_VERSION.replaceAll('-', '_'),
        strict: true,
        schema: GROQ_PATCH_JSON_SCHEMA,
      },
    },
  });
}

function createChallengeRequestBody(
  request: StructuredChallengeRequest,
): string {
  return JSON.stringify({
    model: request.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    stream: false,
    n: 1,
    max_completion_tokens: request.maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: WALKZ_CHALLENGE_SCHEMA_VERSION.replaceAll('-', '_'),
        strict: true,
        schema: GROQ_CHALLENGE_JSON_SCHEMA,
      },
    },
  });
}

function connectionOptions(
  options: GroqProviderOptions,
  signal: AbortSignal | undefined,
): GroqHttpOptions {
  return {
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(signal === undefined ? {} : { signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

async function requestStructuredReviewOnce(
  request: StructuredReviewRequest,
  options: GroqProviderOptions,
  signal: AbortSignal | undefined,
): Promise<StructuredReviewResult> {
  const response = await requestGroqJson(
    {
      method: 'POST',
      path: '/openai/v1/chat/completions',
      body: createRequestBody(request),
    },
    connectionOptions(options, signal),
  );

  let envelope: z.infer<typeof groqChatResponseSchema>;
  try {
    envelope = groqChatResponseSchema.parse(response.data);
  } catch {
    throw responseFailure('Groq returned an invalid chat completion.');
  }
  if (envelope.model !== request.model) {
    throw responseFailure('Groq returned a response from an unexpected model.');
  }
  const choice = envelope.choices[0];
  if (choice === undefined) {
    throw responseFailure('Groq returned no chat completion choice.');
  }
  if (choice.finish_reason !== 'stop') {
    throw responseFailure('Groq did not finish the structured review cleanly.');
  }

  const headerRequestId = parseHeaderText(response.headers, 'x-request-id');
  return {
    provider: 'groq',
    model: envelope.model,
    promptVersion: request.promptVersion,
    schemaVersion: WALKZ_REVIEW_SCHEMA_VERSION,
    review: parseStructuredReview(choice.message.content),
    usage: {
      promptTokens: envelope.usage.prompt_tokens,
      completionTokens: envelope.usage.completion_tokens,
      totalTokens: envelope.usage.total_tokens,
      latencyMs: 0,
      rateLimit: rateLimitFrom(response.headers),
    },
    requestId: headerRequestId ?? envelope.x_groq?.id ?? envelope.id,
  };
}

function parseStructuredPatch(content: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw responseFailure('Groq returned malformed structured patch JSON.');
  }
  try {
    return parseModelPatchResponse(groqStructuredPatchSchema.parse(decoded));
  } catch {
    throw responseFailure('Groq returned an invalid structured patch.');
  }
}

function parseStructuredChallenge(content: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw responseFailure('Groq returned malformed structured challenge JSON.');
  }
  try {
    return parseModelChallengeResponse(
      groqStructuredChallengeSchema.parse(decoded),
    );
  } catch {
    throw responseFailure('Groq returned an invalid structured challenge.');
  }
}

async function requestStructuredChallengeOnce(
  request: StructuredChallengeRequest,
  options: GroqProviderOptions,
  signal: AbortSignal | undefined,
): Promise<StructuredChallengeResult> {
  const response = await requestGroqJson(
    {
      method: 'POST',
      path: '/openai/v1/chat/completions',
      body: createChallengeRequestBody(request),
    },
    connectionOptions(options, signal),
  );
  let envelope: z.infer<typeof groqChatResponseSchema>;
  try {
    envelope = groqChatResponseSchema.parse(response.data);
  } catch {
    throw responseFailure('Groq returned an invalid chat completion.');
  }
  if (envelope.model !== request.model) {
    throw responseFailure('Groq returned a response from an unexpected model.');
  }
  const choice = envelope.choices[0];
  if (choice === undefined || choice.finish_reason !== 'stop') {
    throw responseFailure('Groq did not finish the structured challenge cleanly.');
  }
  const headerRequestId = parseHeaderText(response.headers, 'x-request-id');
  return {
    provider: 'groq',
    model: envelope.model,
    promptVersion: request.promptVersion,
    schemaVersion: WALKZ_CHALLENGE_SCHEMA_VERSION,
    challenge: parseStructuredChallenge(choice.message.content),
    usage: {
      promptTokens: envelope.usage.prompt_tokens,
      completionTokens: envelope.usage.completion_tokens,
      totalTokens: envelope.usage.total_tokens,
      latencyMs: 0,
      rateLimit: rateLimitFrom(response.headers),
    },
    requestId: headerRequestId ?? envelope.x_groq?.id ?? envelope.id,
  };
}

async function requestStructuredPatchOnce(
  request: StructuredPatchRequest,
  options: GroqProviderOptions,
  signal: AbortSignal | undefined,
): Promise<StructuredPatchResult> {
  const response = await requestGroqJson(
    {
      method: 'POST',
      path: '/openai/v1/chat/completions',
      body: createPatchRequestBody(request),
    },
    connectionOptions(options, signal),
  );
  let envelope: z.infer<typeof groqChatResponseSchema>;
  try {
    envelope = groqChatResponseSchema.parse(response.data);
  } catch {
    throw responseFailure('Groq returned an invalid chat completion.');
  }
  if (envelope.model !== request.model) {
    throw responseFailure('Groq returned a response from an unexpected model.');
  }
  const choice = envelope.choices[0];
  if (choice === undefined || choice.finish_reason !== 'stop') {
    throw responseFailure('Groq did not finish the structured patch cleanly.');
  }
  const headerRequestId = parseHeaderText(response.headers, 'x-request-id');
  return {
    provider: 'groq',
    model: envelope.model,
    promptVersion: request.promptVersion,
    schemaVersion: WALKZ_PATCH_SCHEMA_VERSION,
    patch: parseStructuredPatch(choice.message.content),
    usage: {
      promptTokens: envelope.usage.prompt_tokens,
      completionTokens: envelope.usage.completion_tokens,
      totalTokens: envelope.usage.total_tokens,
      latencyMs: 0,
      rateLimit: rateLimitFrom(response.headers),
    },
    requestId: headerRequestId ?? envelope.x_groq?.id ?? envelope.id,
  };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signalIsAborted(signal)) {
    throw toProviderError(new ProviderCancelledError());
  }
  try {
    await delay(
      delayMs,
      undefined,
      signal === undefined ? undefined : { signal },
    );
  } catch (error) {
    if (signalIsAborted(signal)) {
      throw toProviderError(new ProviderCancelledError());
    }
    throw error;
  }
}

async function requestStructuredWithRetry<
  Result extends { usage: { latencyMs: number } },
>(
  request: StructuredReviewRequest,
  options: GroqProviderOptions,
  requestOptions: ProviderRequestOptions,
  operation: (
    request: StructuredReviewRequest,
    options: GroqProviderOptions,
    signal: AbortSignal | undefined,
  ) => Promise<Result>,
): Promise<Result> {
  const normalized = normalizeRequest(request);
  if (!strictModelIds.has(normalized.model)) {
    throw requestFailure(
      'The selected Groq model does not support strict structured output.',
    );
  }
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw requestFailure('Groq maxAttempts must be an integer between 1 and 5.');
  }
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await operation(normalized, options, requestOptions.signal);
      result.usage.latencyMs = Math.max(
        0,
        Math.round(monotonicNow() - startedAt),
      );
      return result;
    } catch (error) {
      const normalizedError = toProviderError(error);
      if (!normalizedError.retryable || attempt + 1 >= maxAttempts) {
        throw normalizedError;
      }
      const delayMs = calculateRetryDelay(attempt, {
        retryAfterMs: normalizedError.retryAfterMs,
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      const sleep = options.sleep ?? waitForRetry;
      try {
        await sleep(delayMs, requestOptions.signal);
      } catch (sleepError) {
        throw toProviderError(sleepError);
      }
      if (signalIsAborted(requestOptions.signal)) {
        throw toProviderError(new ProviderCancelledError());
      }
    }
  }
  throw responseFailure('Groq structured attempts ended without a result.');
}

export async function requestStructuredReview(
  request: StructuredReviewRequest,
  options: GroqProviderOptions,
  requestOptions: ProviderRequestOptions = {},
): Promise<StructuredReviewResult> {
  return requestStructuredWithRetry(
    request,
    options,
    requestOptions,
    requestStructuredReviewOnce,
  );
}

export async function requestStructuredPatch(
  request: StructuredPatchRequest,
  options: GroqProviderOptions,
  requestOptions: ProviderRequestOptions = {},
): Promise<StructuredPatchResult> {
  return requestStructuredWithRetry(
    request,
    options,
    requestOptions,
    requestStructuredPatchOnce,
  );
}

export async function requestStructuredChallenge(
  request: StructuredChallengeRequest,
  options: GroqProviderOptions,
  requestOptions: ProviderRequestOptions = {},
): Promise<StructuredChallengeResult> {
  return requestStructuredWithRetry(
    request,
    options,
    requestOptions,
    requestStructuredChallengeOnce,
  );
}

export function createGroqProvider(
  options: GroqProviderOptions,
): ProviderAdapter {
  return {
    name: 'groq',
    listModels: (requestOptions = {}) =>
      discoverGroqModels({
        ...options,
        ...(requestOptions.signal === undefined
          ? {}
          : { signal: requestOptions.signal }),
      }),
    validateAccess: (requestedModel, requestOptions = {}) =>
      validateProviderAccess({
        ...options,
        requestedModel,
        ...(requestOptions.signal === undefined
          ? {}
          : { signal: requestOptions.signal }),
      }),
    requestStructuredReview: (request, requestOptions = {}) =>
      requestStructuredReview(request, options, requestOptions),
    requestStructuredSecurityReview: (request, requestOptions = {}) =>
      requestStructuredReview(request, options, requestOptions),
    requestStructuredChallenge: (request, requestOptions = {}) =>
      requestStructuredChallenge(request, options, requestOptions),
    requestStructuredPatch: (request, requestOptions = {}) =>
      requestStructuredPatch(request, options, requestOptions),
  };
}
