import process from 'node:process';

import { createHostedWorkerFromEnvironment } from './runtime.js';
import { createStructuredOperationalLogger } from './operational-telemetry.js';

let stopping = false;
let runtime: ReturnType<typeof createHostedWorkerFromEnvironment> | undefined;
const logger = createStructuredOperationalLogger((line) => console.error(line));

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await runtime?.close();
  } catch {
    logger.write({ event: 'service_stop_failed' });
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  runtime = createHostedWorkerFromEnvironment(process.env);
  await runtime.start();
} catch {
  logger.write({ event: 'service_start_failed' });
  await stop();
  process.exitCode = 1;
}
