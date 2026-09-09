import process from 'node:process';

import { createHostedWorkerFromEnvironment } from './runtime.js';

let stopping = false;
let runtime: ReturnType<typeof createHostedWorkerFromEnvironment> | undefined;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime?.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  runtime = createHostedWorkerFromEnvironment(
    process.env,
    () => console.error('A hosted worker background operation failed.'),
  );
  await runtime.start();
} catch {
  console.error('Hosted worker failed to start.');
  await stop();
  process.exitCode = 1;
}
