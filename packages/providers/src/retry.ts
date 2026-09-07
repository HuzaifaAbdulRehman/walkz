export interface RetryDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer.');
  }
}

export function calculateRetryDelay(
  attempt: number,
  options: RetryDelayOptions = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 10) {
    throw new Error('Retry attempt must be an integer between 0 and 10.');
  }
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  positiveInteger(baseDelayMs, 'Base retry delay');
  positiveInteger(maxDelayMs, 'Maximum retry delay');
  if (baseDelayMs > maxDelayMs) {
    throw new Error('Base retry delay cannot exceed the maximum retry delay.');
  }
  if (
    options.retryAfterMs !== undefined &&
    options.retryAfterMs !== null &&
    (!Number.isInteger(options.retryAfterMs) || options.retryAfterMs < 0)
  ) {
    throw new Error('Retry-After delay must be a non-negative integer.');
  }
  const random = options.random ?? Math.random;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('Retry random source must return a value between 0 and 1.');
  }
  const exponentialCap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitteredDelay = Math.floor(exponentialCap * sample);
  const serverDelay = options.retryAfterMs ?? 0;
  return Math.max(jitteredDelay, serverDelay);
}
