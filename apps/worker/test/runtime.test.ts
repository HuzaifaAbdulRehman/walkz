import { describe, expect, it } from 'vitest';

import { parseHostedWorkerEnvironment } from '../src/runtime.js';

const privateKey = [
  '-----BEGIN PRIVATE KEY-----',
  'test-only-placeholder',
  '-----END PRIVATE KEY-----',
].join('\n');
const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://walkz:secret@database.example/walkz',
    REDIS_URL: 'rediss://worker:redis%20secret@redis.example:6380/2',
    GITHUB_APP_ID: '1234',
    GITHUB_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
    WALKZ_CREDENTIAL_ACTIVE_KEY_ID: 'primary-2026',
    WALKZ_CREDENTIAL_KEYS_JSON: JSON.stringify({
      'primary-2026': encryptionKey,
    }),
    WALKZ_WORKER_ID: 'worker-1',
  };
}

describe('hosted worker runtime configuration', () => {
  it('parses bounded database, Redis, GitHub, and encryption settings', () => {
    const config = parseHostedWorkerEnvironment(environment());

    expect(config).toMatchObject({
      databaseUrl: 'postgresql://walkz:secret@database.example/walkz',
      githubAppId: '1234',
      githubPrivateKey: privateKey,
      workerId: 'worker-1',
      outboxLeaseMs: 30_000,
      reviewLeaseMs: 300_000,
      recoveryIntervalMs: 15_000,
      recoveryBatch: 100,
      redis: {
        host: 'redis.example',
        port: 6380,
        db: 2,
        username: 'worker',
        password: 'redis secret',
        maxRetriesPerRequest: null,
        tls: { servername: 'redis.example' },
      },
    });
  });

  it('rejects unsupported Redis URL data without echoing credentials', () => {
    const input = environment();
    input.REDIS_URL = 'https://user:very-secret@example.com/0';

    expect(() => parseHostedWorkerEnvironment(input)).toThrow(
      'must be a redis or rediss URL',
    );
    try {
      parseHostedWorkerEnvironment(input);
    } catch (error) {
      expect(String(error)).not.toContain('very-secret');
    }
  });
});
