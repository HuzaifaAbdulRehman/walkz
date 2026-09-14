import { describe, expect, it } from 'vitest';

import { createHttpOperationalTelemetry } from '../src/operational-telemetry.js';

describe('API operational telemetry', () => {
  it('keeps fixed status and latency dimensions', () => {
    const telemetry = createHttpOperationalTelemetry(() => 1_000);

    telemetry.observe(201, 12.4);
    telemetry.observe(404, 7.8);
    telemetry.observe(503, 3.2);

    expect(telemetry.snapshot()).toEqual({
      uptimeSeconds: 0,
      requests: {
        total: 3,
        byStatusClass: {
          informational: 0,
          successful: 1,
          redirection: 0,
          clientError: 1,
          serverError: 1,
        },
      },
      latencyMs: { count: 3, total: 23, maximum: 12 },
    });
  });

  it('normalizes invalid observations without creating labels', () => {
    const telemetry = createHttpOperationalTelemetry();

    telemetry.observe(999, Number.NaN);

    expect(telemetry.snapshot()).toMatchObject({
      requests: { total: 1, byStatusClass: { serverError: 1 } },
      latencyMs: { count: 1, total: 0, maximum: 0 },
    });
  });
});
