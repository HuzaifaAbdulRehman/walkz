import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  consumeOAuthState,
  createPersistentGitHubSessionService,
  purgeExpiredOAuthStates,
  purgeExpiredSessions,
  storeOAuthState,
} from '../src/index.js';

const stateId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const userId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const installationId = 'ceba6567-b8f1-4f79-bc68-cfbdca681d23';

describe('durable authentication state', () => {
  it('stores and atomically consumes an unexpired OAuth state once', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: stateId }] })
      .mockResolvedValueOnce({ rows: [] });
    const now = new Date('2026-09-09T12:00:00.000Z');

    await storeOAuthState({ query }, { stateId, expiresAt: new Date(now.getTime() + 60_000) });
    await expect(consumeOAuthState({ query }, { stateId, now })).resolves.toBe(true);
    await expect(consumeOAuthState({ query }, { stateId, now })).resolves.toBe(false);
    expect(query.mock.calls[1]?.[0]).toContain('consumed_at IS NULL AND expires_at > $2');
  });

  it('purges expired OAuth state and revoked or expired sessions', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const before = new Date('2026-09-09T12:00:00.000Z');

    await expect(purgeExpiredOAuthStates({ query }, before)).resolves.toBe(3);
    await expect(purgeExpiredSessions({ query }, before)).resolves.toBe(2);
    expect(query.mock.calls[0]?.[0]).toContain('expires_at <= $1');
    expect(query.mock.calls[1]?.[0]).toContain('revoked_at <= $1');
  });

  it('synchronizes identity and stores only a hash of a random session token', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: userId }] };
      if (sql.includes('INSERT INTO github_installations')) return { rows: [{ id: installationId }] };
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }), query };
    const resolver = { load: vi.fn().mockResolvedValue({
      githubId: '123',
      login: 'octocat',
      installations: [{
        installationId: '456',
        accountLogin: 'octocat',
        repositories: [{ githubId: '789', owner: 'octocat', name: 'walkz' }],
      }],
    }) };
    const service = createPersistentGitHubSessionService(
      pool as unknown as Pick<Pool, 'connect' | 'query'>,
      resolver,
      {
      now: () => new Date('2026-09-09T12:00:00.000Z'),
      ttlMs: 60_000,
      },
    );

    const session = await service.create('ghu_temporary-user-token');

    expect(session.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const allValues = calls.flatMap((call) => call[1] ?? []);
    expect(allValues).not.toContain('ghu_temporary-user-token');
    expect(allValues).toContain(createHash('sha256').update(session.sessionId).digest('hex'));
    expect(query.mock.calls.some((call) => String(call[0]).includes('DELETE FROM user_installations'))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO user_repository_access'))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('authenticates active sessions and revokes them by token hash', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ userId, installationIds: ['456'], repositoryIds: [stateId] }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const pool = { connect: vi.fn(), query };
    const service = createPersistentGitHubSessionService(
      pool as unknown as Pick<Pool, 'connect' | 'query'>,
      { load: vi.fn() },
    );
    const sessionId = 'a'.repeat(43);

    await expect(service.authenticate(sessionId)).resolves.toEqual({
      userId,
      installationIds: ['456'],
      repositoryIds: [stateId],
    });
    await expect(service.revoke(sessionId)).resolves.toBe(true);
    const expectedHash = createHash('sha256').update(sessionId).digest('hex');
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(expectedHash);
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(expectedHash);
  });
});
