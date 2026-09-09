import { describe, expect, it, vi } from 'vitest';

import { createApiSessionAuthenticator, readSessionCookie } from '../src/index.js';

describe('API session authentication', () => {
  it('authenticates a valid cookie without trusting other cookie values', async () => {
    const principal = {
      userId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      installationIds: ['123'],
      repositoryIds: ['3d963b52-8203-4ba6-bcac-15bf132371f0'],
    };
    const authenticate = vi.fn().mockResolvedValue(principal);
    const authenticator = createApiSessionAuthenticator({ authenticate });

    await expect(authenticator.authenticate({
      headers: { cookie: `theme=dark; walkz_session=${'a'.repeat(43)}; ignored=value` },
    })).resolves.toEqual(principal);
    expect(authenticate).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('fails closed for missing, malformed, or rejected sessions', async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error('invalid session'));
    const authenticator = createApiSessionAuthenticator({ authenticate });

    await expect(authenticator.authenticate({ headers: {} })).resolves.toBeNull();
    await expect(authenticator.authenticate({
      headers: { cookie: 'walkz_session=%E0%A4%A' },
    })).resolves.toBeNull();
    await expect(authenticator.authenticate({
      headers: { cookie: `walkz_session=${'a'.repeat(43)}` },
    })).resolves.toBeNull();
  });

  it('selects only the Walkz session cookie', () => {
    expect(readSessionCookie('walkz_session=token; walkz_session_backup=other')).toBe('token');
  });
});
