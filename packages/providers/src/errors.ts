export type ProviderErrorCode =
  | 'authentication'
  | 'cancelled'
  | 'invalid_request'
  | 'invalid_response'
  | 'model_unavailable'
  | 'network'
  | 'permission'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'server'
  | 'timeout';

export interface ProviderFailure {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  status: number | null;
  retryAfterMs: number | null;
}

export class ProviderError extends Error implements ProviderFailure {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(failure: ProviderFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = 'ProviderError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.status = failure.status;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly quotaExhausted: boolean;

  constructor(
    status: number,
    retryAfterMs: number | null,
    providerMessage: string | null,
  ) {
    super('Provider request failed with HTTP status ' + status + '.');
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.quotaExhausted =
      providerMessage !== null && /quota|billing|credit|spend/i.test(providerMessage);
  }
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super('Provider request timed out.');
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderCancelledError extends Error {
  constructor(options?: ErrorOptions) {
    super('The provider request was cancelled.', options);
    this.name = 'ProviderCancelledError';
  }
}

export class ProviderNetworkError extends Error {
  constructor(options?: ErrorOptions) {
    super('The provider could not be reached.', options);
    this.name = 'ProviderNetworkError';
  }
}

function normalizedFailure(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  status: number | null = null,
  retryAfterMs: number | null = null,
): ProviderFailure {
  return { code, message, retryable, status, retryAfterMs };
}

function classifyHttpError(error: ProviderHttpError): ProviderFailure {
  if (error.status === 401) {
    return normalizedFailure(
      'authentication',
      'The provider rejected the API key.',
      false,
      error.status,
    );
  }
  if (error.status === 403) {
    return normalizedFailure(
      'permission',
      'The provider denied access to this resource.',
      false,
      error.status,
    );
  }
  if (error.status === 404) {
    return normalizedFailure(
      'model_unavailable',
      'The requested provider model is unavailable.',
      false,
      error.status,
    );
  }
  if (error.status === 408) {
    return normalizedFailure(
      'timeout',
      'The provider request timed out.',
      true,
      error.status,
    );
  }
  if (error.status === 422) {
    return normalizedFailure(
      'invalid_response',
      'The provider could not produce the requested structured response.',
      true,
      error.status,
    );
  }
  if (error.status === 429) {
    return normalizedFailure(
      error.quotaExhausted ? 'quota_exhausted' : 'rate_limited',
      error.quotaExhausted
        ? 'The provider quota is exhausted.'
        : 'The provider rate limit was reached.',
      !error.quotaExhausted,
      error.status,
      error.retryAfterMs,
    );
  }
  if (error.status >= 500) {
    return normalizedFailure(
      'server',
      'The provider is temporarily unavailable.',
      true,
      error.status,
    );
  }
  return normalizedFailure(
    'invalid_request',
    'The provider rejected the request.',
    false,
    error.status,
  );
}

export function classifyProviderError(error: unknown): ProviderFailure {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof ProviderHttpError) {
    return classifyHttpError(error);
  }
  if (error instanceof ProviderTimeoutError) {
    return normalizedFailure(
      'timeout',
      'The provider request timed out.',
      true,
    );
  }
  if (error instanceof ProviderCancelledError) {
    return normalizedFailure(
      'cancelled',
      'The provider request was cancelled.',
      false,
    );
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return normalizedFailure(
      'cancelled',
      'The provider request was cancelled.',
      false,
    );
  }
  if (error instanceof SyntaxError) {
    return normalizedFailure(
      'invalid_response',
      'The provider returned an invalid response.',
      false,
    );
  }
  if (error instanceof ProviderNetworkError) {
    return normalizedFailure(
      'network',
      'The provider could not be reached.',
      true,
    );
  }
  return normalizedFailure(
    'invalid_response',
    'The provider returned an unexpected failure.',
    false,
  );
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const failure = classifyProviderError(error);
  return error instanceof Error
    ? new ProviderError(failure, { cause: error })
    : new ProviderError(failure);
}
