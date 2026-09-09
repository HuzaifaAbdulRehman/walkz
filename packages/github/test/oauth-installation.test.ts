import { describe, expect, it } from 'vitest';

import {
  createOAuthStateSigner,
  parseReadOnlyInstallation,
} from '../src/index.js';

const stateId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const secret = 'a'.repeat(32);

describe('GitHub App authentication boundary', () => {
  it('signs, verifies, and expires OAuth state', () => {
    let now = 1_000;
    const signer = createOAuthStateSigner(secret, {
      ttlMs: 100,
      now: () => now,
    });
    const issued = signer.issue({ stateId, returnTo: '/reviews?status=open' });

    expect(issued.expiresAt).toBe(now + 100);
    expect(signer.verify(issued.token)).toEqual({ stateId, returnTo: '/reviews?status=open' });

    now = 2_000;
    const expired = createOAuthStateSigner(secret, { ttlMs: 100, now: () => now - 200 });
    const expiredToken = expired.issue({ stateId, returnTo: '/reviews' }).token;
    now = 2_500;
    expect(() => expired.verify(expiredToken)).toThrow('expired');
  });

  it('rejects tampered state and write-capable installation permissions', () => {
    const signer = createOAuthStateSigner(secret);
    const token = signer.issue({ stateId, returnTo: '/reviews' }).token;
    const [payload, signature] = token.split('.');
    expect(() => signer.verify(`${payload}.${signature}x`)).toThrow();
    expect(() => parseReadOnlyInstallation({
      installationId: '123',
      repositories: [{ githubId: '456', owner: 'owner', name: 'repo' }],
      permissions: {
        metadata: 'read',
        contents: 'write',
        pullRequests: 'read',
        checks: 'write',
        issues: 'read',
      },
    })).toThrow('read-only app boundary');
  });

  it('accepts selected repositories with read-only contents access', () => {
    expect(parseReadOnlyInstallation({
      installationId: '123',
      repositories: [{ githubId: '456', owner: 'owner', name: 'repo' }],
      permissions: {
        metadata: 'read',
        contents: 'read',
        pullRequests: 'read',
        checks: 'write',
        issues: 'read',
      },
    }).repositories).toHaveLength(1);
  });
});
