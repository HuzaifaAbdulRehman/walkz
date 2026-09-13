import { createHash } from 'node:crypto';

import {
  parseModelInvocationEvent,
  type ModelInvocationEvent,
  type ModelInvocationStage,
  type ProviderAdapter,
  type StructuredPatchRequest,
  type StructuredPatchResult,
  type StructuredReviewRequest,
  type StructuredReviewResult,
} from '@walkz/contracts';
import { z } from 'zod';

import { classifyProviderError } from './errors.js';

const optionsSchema = z.object({
  operationId: z.string().trim().min(1).max(1_024)
    .refine((value) => !value.includes('\0')),
}).strict();

export interface ModelInvocationTelemetryOptions {
  operationId: string;
  record(event: ModelInvocationEvent): Promise<void>;
  now?: () => number;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot hash a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error('Cannot hash an unsupported value.');
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.min(60 * 60 * 1_000, Math.max(0, Math.floor(now() - startedAt)));
}

function requestHash(request: StructuredReviewRequest): string {
  return digest({
    maxOutputTokens: request.maxOutputTokens,
    model: request.model,
    promptVersion: request.promptVersion,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
  });
}

function invocationKey(operationId: string, stage: ModelInvocationStage): string {
  return digest({ operationId, stage });
}

async function observeRequest<Result extends StructuredReviewResult | StructuredPatchResult>(
  provider: ProviderAdapter,
  stage: 'review' | 'patch',
  operationId: string,
  request: StructuredReviewRequest,
  perform: () => Promise<Result>,
  record: ModelInvocationTelemetryOptions['record'],
  now: () => number,
): Promise<Result> {
  const startedAt = now();
  const common = {
    invocationKey: invocationKey(operationId, stage),
    stage,
    provider: provider.name,
    model: request.model,
    promptVersion: request.promptVersion,
    promptHash: requestHash(request),
  } as const;
  let result: Result;
  try {
    result = await perform();
  } catch (error) {
    const failure = classifyProviderError(error);
    await record(parseModelInvocationEvent({
      ...common,
      status: 'failed',
      responseHash: null,
      usage: null,
      requestId: null,
      errorCode: failure.code,
      durationMs: elapsedMs(startedAt, now),
    }));
    throw error;
  }
  const response = 'review' in result
    ? { schemaVersion: result.schemaVersion, review: result.review }
    : { schemaVersion: result.schemaVersion, patch: result.patch };
  await record(parseModelInvocationEvent({
    ...common,
    status: 'succeeded',
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    responseHash: digest(response),
    usage: result.usage,
    requestId: result.requestId,
    errorCode: null,
    durationMs: elapsedMs(startedAt, now),
  }));
  return result;
}

export function withModelInvocationTelemetry(
  provider: ProviderAdapter,
  options: ModelInvocationTelemetryOptions,
): ProviderAdapter {
  const parsed = optionsSchema.parse({ operationId: options.operationId });
  const now = options.now ?? Date.now;
  return {
    name: provider.name,
    listModels: (requestOptions) => provider.listModels(requestOptions),
    validateAccess: (requestedModel, requestOptions) =>
      provider.validateAccess(requestedModel, requestOptions),
    requestStructuredReview: (request, requestOptions) => observeRequest(
      provider,
      'review',
      parsed.operationId,
      request,
      () => provider.requestStructuredReview(request, requestOptions),
      options.record,
      now,
    ),
    ...(provider.requestStructuredPatch === undefined
      ? {}
      : {
          requestStructuredPatch: (
            request: StructuredPatchRequest,
            requestOptions?: Parameters<NonNullable<
              ProviderAdapter['requestStructuredPatch']
            >>[1],
          ) => observeRequest(
            provider,
            'patch',
            parsed.operationId,
            request,
            () => provider.requestStructuredPatch!(request, requestOptions),
            options.record,
            now,
          ),
        }),
  };
}
