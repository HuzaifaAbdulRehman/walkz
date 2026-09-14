const statusClasses = [
  'informational',
  'successful',
  'redirection',
  'clientError',
  'serverError',
] as const;

type StatusClass = typeof statusClasses[number];

export interface HttpOperationalTelemetrySnapshot {
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatusClass: Record<StatusClass, number>;
  };
  latencyMs: {
    count: number;
    total: number;
    maximum: number;
  };
}

export interface HttpOperationalTelemetry {
  observe(statusCode: number, latencyMs: number): void;
  snapshot(): HttpOperationalTelemetrySnapshot;
}

function classifyStatus(statusCode: number): StatusClass {
  if (statusCode >= 100 && statusCode < 200) return 'informational';
  if (statusCode >= 200 && statusCode < 300) return 'successful';
  if (statusCode >= 300 && statusCode < 400) return 'redirection';
  if (statusCode >= 400 && statusCode < 500) return 'clientError';
  return 'serverError';
}

function zeroStatusClasses(): Record<StatusClass, number> {
  return Object.fromEntries(statusClasses.map((value) => [value, 0])) as
    Record<StatusClass, number>;
}

export function createHttpOperationalTelemetry(
  now: () => number = Date.now,
): HttpOperationalTelemetry {
  const startedAt = now();
  const byStatusClass = zeroStatusClasses();
  let requestCount = 0;
  let totalLatencyMs = 0;
  let maximumLatencyMs = 0;

  return {
    observe(statusCode, latencyMs) {
      const normalizedLatency = Number.isFinite(latencyMs) && latencyMs > 0
        ? Math.round(latencyMs)
        : 0;
      requestCount += 1;
      byStatusClass[classifyStatus(statusCode)] += 1;
      totalLatencyMs += normalizedLatency;
      maximumLatencyMs = Math.max(maximumLatencyMs, normalizedLatency);
    },
    snapshot() {
      return {
        uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1_000)),
        requests: {
          total: requestCount,
          byStatusClass: { ...byStatusClass },
        },
        latencyMs: {
          count: requestCount,
          total: totalLatencyMs,
          maximum: maximumLatencyMs,
        },
      };
    },
  };
}
