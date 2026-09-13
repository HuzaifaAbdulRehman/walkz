import type { ModelReviewResponse } from './review.js';
import type { ModelPatchResponse } from './patch-generation.js';
import type { ModelChallengeResponse } from './challenge.js';

export type ProviderName = 'groq' | 'mock';

export interface ProviderModel {
  id: string;
  active: boolean;
  contextWindow: number | null;
  maxCompletionTokens: number | null;
  supportsStrictStructuredOutput: boolean;
}

export interface ProviderRateLimit {
  retryAfterMs: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequests: string | null;
  resetTokens: string | null;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  rateLimit: ProviderRateLimit;
}

export interface ProviderAccessResult {
  provider: ProviderName;
  selectedModel: string;
  models: ProviderModel[];
  privacyNotice: string;
  dataControlsUrl: string | null;
}

export interface StructuredReviewRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  promptVersion: string;
}

export interface StructuredReviewResult {
  provider: ProviderName;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  review: ModelReviewResponse;
  usage: ProviderUsage;
  requestId: string | null;
}

export type StructuredPatchRequest = StructuredReviewRequest;

export type StructuredChallengeRequest = StructuredReviewRequest;

export interface StructuredPatchResult {
  provider: ProviderName;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  patch: ModelPatchResponse;
  usage: ProviderUsage;
  requestId: string | null;
}

export interface StructuredChallengeResult {
  provider: ProviderName;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  challenge: ModelChallengeResponse;
  usage: ProviderUsage;
  requestId: string | null;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal | undefined;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  listModels(options?: ProviderRequestOptions): Promise<ProviderModel[]>;
  validateAccess(
    requestedModel: string,
    options?: ProviderRequestOptions,
  ): Promise<ProviderAccessResult>;
  requestStructuredReview(
    request: StructuredReviewRequest,
    options?: ProviderRequestOptions,
  ): Promise<StructuredReviewResult>;
  requestStructuredChallenge?(
    request: StructuredChallengeRequest,
    options?: ProviderRequestOptions,
  ): Promise<StructuredChallengeResult>;
  requestStructuredPatch?(
    request: StructuredPatchRequest,
    options?: ProviderRequestOptions,
  ): Promise<StructuredPatchResult>;
}
