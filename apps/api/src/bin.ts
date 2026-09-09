import process from 'node:process';

import { createHostedApiFromEnvironment } from './runtime.js';

const { app, config } = createHostedApiFromEnvironment(process.env);
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Hosted API failed to start');
  await stop();
  process.exitCode = 1;
}
