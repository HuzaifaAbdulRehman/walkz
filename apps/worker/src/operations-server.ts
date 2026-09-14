import {
  createServer,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DurableOperationalTelemetry } from '@walkz/persistence';

import {
  type WorkerOperationalTelemetry,
  type WorkerQueueName,
  workerQueueNames,
} from './operational-telemetry.js';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

export type WorkerDependencySnapshot = Record<'postgres' | 'redis', DependencyStatus>;

export interface WorkerQueueCounts {
  wait: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface WorkerOperationsMetrics {
  queues: Record<WorkerQueueName, WorkerQueueCounts>;
  durable: DurableOperationalTelemetry;
}

export interface WorkerOperationsServer {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

interface WorkerOperationsServerOptions {
  host: string;
  port: number;
  telemetry: WorkerOperationalTelemetry;
  dependencies: {
    check(): Promise<WorkerDependencySnapshot>;
  };
  metrics: {
    load(): Promise<WorkerOperationsMetrics>;
  };
  timeoutMs?: number;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
}

function dependenciesReady(snapshot: WorkerDependencySnapshot): boolean {
  return snapshot.postgres.status === 'up' && snapshot.redis.status === 'up';
}

function unavailableDependencies(): WorkerDependencySnapshot {
  return {
    postgres: { status: 'down', latencyMs: 0 },
    redis: { status: 'down', latencyMs: 0 },
  };
}

function copyMetrics(metrics: WorkerOperationsMetrics): WorkerOperationsMetrics {
  const count = (value: number): number =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    queues: Object.fromEntries(workerQueueNames.map((name) => [
      name,
      {
        wait: count(metrics.queues[name].wait),
        active: count(metrics.queues[name].active),
        delayed: count(metrics.queues[name].delayed),
        failed: count(metrics.queues[name].failed),
      },
    ])) as Record<WorkerQueueName, WorkerQueueCounts>,
    durable: metrics.durable,
  };
}

async function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Worker operations server did not bind a TCP address.');
  }
  return address;
}

function coalesce<T>(operation: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | undefined;
  return () => {
    active ??= operation().finally(() => {
      active = undefined;
    });
    return active;
  };
}

function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Worker operations deadline reached.')),
      timeoutMs,
    );
    timer.unref();
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createWorkerOperationsServer(
  options: WorkerOperationsServerOptions,
): WorkerOperationsServer {
  const timeoutMs = Math.max(1, Math.min(5_000, options.timeoutMs ?? 1_500));
  const checkDependencies = coalesce(() => options.dependencies.check());
  const loadMetrics = coalesce(() => options.metrics.load());
  const server = createServer({
    headersTimeout: 5_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 8_192,
    requestTimeout: 5_000,
  }, async (request, response) => {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const path = new URL(request.url ?? '/', 'http://worker.invalid').pathname;
    if (path === '/health/live') {
      writeJson(response, 200, { status: 'live' });
      return;
    }
    if (path === '/health/ready') {
      try {
        const dependencies = await within(checkDependencies(), timeoutMs);
        writeJson(response, dependenciesReady(dependencies) ? 200 : 503, {
          status: dependenciesReady(dependencies) ? 'ready' : 'not_ready',
        });
      } catch {
        writeJson(response, 503, { status: 'not_ready' });
      }
      return;
    }
    if (path !== '/ops/telemetry') {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    const [dependencyResult, metricsResult] = await Promise.allSettled([
      within(checkDependencies(), timeoutMs),
      within(loadMetrics(), timeoutMs),
    ]);
    const dependencies = dependencyResult.status === 'fulfilled'
      ? dependencyResult.value
      : unavailableDependencies();
    const metrics = metricsResult.status === 'fulfilled'
      ? copyMetrics(metricsResult.value)
      : null;
    writeJson(
      response,
      dependenciesReady(dependencies) && metrics !== null ? 200 : 503,
      {
        schemaVersion: 1,
        service: 'worker',
        generatedAt: new Date().toISOString(),
        dependencies,
        process: options.telemetry.snapshot(),
        metrics,
      },
    );
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;

  return {
    async start() {
      const address = await listen(server, options.host, options.port);
      return { host: address.address, port: address.port };
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
