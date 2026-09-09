import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  consumeOAuthState,
  createPersistentGitHubSessionService,
  storeOAuthState,
} from '../src/index.js';

const connectionString = process.env.WALKZ_POSTGRES_TEST_URL;
const describeWithPostgres = connectionString === undefined ? describe.skip : describe;

describeWithPostgres('durable authentication integration', () => {
  const pool = new Pool({ connectionString });
  const stateId = randomUUID();
  const repositoryId = randomUUID();
  const userGitHubId = String(randomInt(100_000_000, 999_999_999));
  const installationGitHubId = String(randomInt(100_000_000, 999_999_999));
  let userId: string | undefined;
  let installationId: string | undefined;

  beforeAll(async () => {
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    if (userId !== undefined) await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    if (userId !== undefined) await pool.query('DELETE FROM user_installations WHERE user_id = $1', [userId]);
    if (installationId !== undefined) await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
    if (userId !== undefined) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM oauth_states WHERE id = $1', [stateId]);
    await pool.end();
  });

  it('survives restart, scopes access, rejects replay, and revokes the session', async () => {
    const now = new Date();
    await storeOAuthState(pool, { stateId, expiresAt: new Date(now.getTime() + 60_000) });
    await expect(consumeOAuthState(pool, { stateId, now })).resolves.toBe(true);
    await expect(consumeOAuthState(pool, { stateId, now })).resolves.toBe(false);

    const identity = {
      githubId: userGitHubId,
      login: 'integration-user',
      installations: [{
        installationId: installationGitHubId,
        accountLogin: 'integration-owner',
        repositories: [{
          githubId: '987654321',
          owner: 'owner',
          name: 'repo',
        }],
      }],
    };
    const firstService = createPersistentGitHubSessionService(
      pool,
      { load: vi.fn().mockResolvedValue(identity) },
      { now: () => now, ttlMs: 60_000 },
    );
    const session = await firstService.create('ghu_ephemeral-integration-token');
    const userResult = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE github_id = $1',
      [userGitHubId],
    );
    userId = userResult.rows[0]?.id;
    const installationResult = await pool.query<{ id: string }>(
      'SELECT id FROM github_installations WHERE github_id = $1',
      [installationGitHubId],
    );
    installationId = installationResult.rows[0]?.id;
    if (userId === undefined || installationId === undefined) {
      throw new Error('Authentication fixtures were not stored.');
    }
    await pool.query(
      `INSERT INTO repositories (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [repositoryId, installationId, '987654321', 'owner', 'repo'],
    );

    const restartedService = createPersistentGitHubSessionService(pool, { load: vi.fn() }, {
      now: () => new Date(now.getTime() + 1_000),
    });
    await expect(restartedService.authenticate(session.sessionId)).resolves.toEqual({
      userId,
      installationIds: [installationGitHubId],
      repositoryIds: [repositoryId],
    });
    const storedSession = await pool.query<{ tokenHash: string }>(
      'SELECT token_hash AS "tokenHash" FROM sessions WHERE user_id = $1',
      [userId],
    );
    expect(storedSession.rows[0]?.tokenHash).not.toBe(session.sessionId);

    await expect(restartedService.revoke(session.sessionId)).resolves.toBe(true);
    await expect(restartedService.authenticate(session.sessionId)).resolves.toBeNull();
  });
});
