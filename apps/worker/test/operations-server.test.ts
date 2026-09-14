import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerOperationalTelemetry } from '../src/operational-telemetry.js';
import {
  createWorkerOperationsServer,
  type WorkerOperationsServer,
} from '../src/operations-server.js';

const servers: WorkerOperationsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('worker operations server', () => {
  it('serves bounded liveness, readiness, and telemetry JSON', async () => {
    const server = createWorkerOperationsServer({
      host: '127.0.0.1',
      port: 0,
      telemetry: createWorkerOperationalTelemetry(),
      dependencies: {
        check: vi.fn().mockResolvedValue({
          postgres: { status: 'up', latencyMs: 3 },
          redis: { status: 'up', latencyMs: 2 },
        }),
      },
      metrics: {
        load: vi.fn().mockResolvedValue({
          queues: {
            reviews: { wait: 1, active: 0, delayed: 0, failed: 0 },
            outbox: { wait: 0, active: 0, delayed: 0, failed: 0 },
            comment_commands: { wait: 0, active: 0, delayed: 0, failed: 0 },
            patch_fixes: { wait: 0, active: 0, delayed: 0, failed: 0 },
          },
          durable: {
            windowHours: 24,
            reviewRuns: { byStatus: { completed: 1 }, byVerdict: { FIX: 1 } },
            outbox: { pending: 0, oldestPendingAgeMs: null },
          },
        }),
      },
    });
    servers.push(server);
    const address = await server.start();
    const base = `http://127.0.0.1:${address.port}`;

    const [live, ready, telemetry, missing, method] = await Promise.all([
      fetch(`${base}/health/live`),
      fetch(`${base}/health/ready`),
      fetch(`${base}/ops/telemetry`),
      fetch(`${base}/missing`),
      fetch(`${base}/ops/telemetry`, { method: 'POST' }),
    ]);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    expect(telemetry.status).toBe(200);
    expect(telemetry.headers.get('cache-control')).toBe('private, no-store');
    expect(await telemetry.json()).toMatchObject({
      schemaVersion: 1,
      service: 'worker',
      dependencies: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
      },
      metrics: {
        queues: { reviews: { wait: 1 } },
        durable: { reviewRuns: { byVerdict: { FIX: 1 } } },
      },
    });
    expect(missing.status).toBe(404);
    expect(method.status).toBe(405);
  });

  it('reports unavailable dependencies without exposing failure text', async () => {
    const server = createWorkerOperationsServer({
      host: '127.0.0.1',
      port: 0,
      telemetry: createWorkerOperationalTelemetry(),
      dependencies: {
        check: vi.fn().mockResolvedValue({
          postgres: { status: 'down', latencyMs: 5 },
          redis: { status: 'up', latencyMs: 1 },
        }),
      },
      metrics: {
        load: vi.fn().mockRejectedValue(new Error('database password leaked')),
      },
    });
    servers.push(server);
    const address = await server.start();
    const base = `http://127.0.0.1:${address.port}`;

    const ready = await fetch(`${base}/health/ready`);
    const telemetry = await fetch(`${base}/ops/telemetry`);
    const telemetryBody = await telemetry.text();

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'not_ready' });
    expect(telemetry.status).toBe(503);
    expect(JSON.parse(telemetryBody)).toMatchObject({
      dependencies: { postgres: { status: 'down' } },
      metrics: null,
    });
    expect(telemetryBody).not.toContain('database password leaked');
  });

  it('bounds repeated checks when a dependency call does not settle', async () => {
    const check = vi.fn().mockReturnValue(new Promise(() => undefined));
    const server = createWorkerOperationsServer({
      host: '127.0.0.1',
      port: 0,
      timeoutMs: 20,
      telemetry: createWorkerOperationalTelemetry(),
      dependencies: { check },
      metrics: {
        load: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    });
    servers.push(server);
    const address = await server.start();

    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/health/ready`),
      fetch(`http://127.0.0.1:${address.port}/health/ready`),
    ]);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(check).toHaveBeenCalledOnce();
  });
});
