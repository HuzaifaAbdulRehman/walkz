import {
  ProviderCancelledError,
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  toProviderError,
} from './errors.js';

const GROQ_API_ORIGIN = 'https://api.groq.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface GroqHttpOptions {
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export interface GroqJsonRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
}

export interface GroqJsonResponse {
  data: unknown;
  headers: Headers;
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      name + ' must be an integer between 1 and ' + maximum + '.',
    );
  }
}

function requireApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (normalized.length === 0) {
    throw new ProviderError({
      code: 'authentication',
      message: 'Set GROQ_API_KEY before using the Groq provider.',
      retryable: false,
      status: null,
      retryAfterMs: null,
    });
  }
  return normalized;
}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxResponseBytes
  ) {
    throw new ProviderError({
      code: 'invalid_response',
      message: 'The provider response exceeded the configured size limit.',
      retryable: false,
      status: response.status,
      retryAfterMs: null,
    });
  }
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxResponseBytes) {
        await reader.cancel();
        throw new ProviderError({
          code: 'invalid_response',
          message: 'The provider response exceeded the configured size limit.',
          retryable: false,
          status: response.status,
          retryAfterMs: null,
        });
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseRetryAfter(value: string | null, now: () => number): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = Math.ceil(seconds * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return null;
  }
  const milliseconds = Math.max(0, date - now());
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function readProviderMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      'message' in parsed.error &&
      typeof parsed.error.message === 'string'
    ) {
      return parsed.error.message.slice(0, 2_000);
    }
  } catch {
    return null;
  }
  return null;
}

export async function requestGroqJson(
  request: GroqJsonRequest,
  options: GroqHttpOptions,
): Promise<GroqJsonResponse> {
  const apiKey = requireApiKey(options.apiKey);
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  positiveInteger(maxResponseBytes, 'Provider response limit', 5_242_880);
  const headers = new Headers({
    accept: 'application/json',
    authorization: 'Bearer ' + apiKey,
  });
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  positiveInteger(timeoutMs, 'Provider timeout', 300_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let responseReceived = false;
  const abortFromCaller = (): void => {
    callerAborted = true;
    controller.abort(options.signal?.reason);
  };

  if (options.signal?.aborted === true) {
    throw toProviderError(new ProviderCancelledError());
  }
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref();

  try {
    const response = await fetchImplementation(
      new URL(request.path, GROQ_API_ORIGIN),
      {
        headers,
        method: request.method,
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      },
    );
    responseReceived = true;
    const body = await readBoundedText(response, maxResponseBytes);
    if (!response.ok) {
      throw toProviderError(
        new ProviderHttpError(
          response.status,
          parseRetryAfter(
            response.headers.get('retry-after'),
            options.now ?? Date.now,
          ),
          readProviderMessage(body),
        ),
      );
    }

    try {
      return { data: JSON.parse(body) as unknown, headers: response.headers };
    } catch (error) {
      throw toProviderError(error);
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (timedOut) {
      throw toProviderError(new ProviderTimeoutError());
    }
    if (callerAborted) {
      throw toProviderError(
        new ProviderCancelledError(),
      );
    }
    if (!responseReceived || error instanceof TypeError) {
      throw toProviderError(new ProviderNetworkError());
    }
    throw toProviderError(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
