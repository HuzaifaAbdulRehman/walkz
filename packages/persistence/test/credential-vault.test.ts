import { describe, expect, it, vi } from 'vitest';

import {
  createCredentialVault,
  decryptCredential,
  encryptCredential,
  storeProviderCredential,
} from '../src/index.js';

const key = Buffer.alloc(32, 7).toString('base64');
const vault = createCredentialVault({
  activeKeyId: 'primary-2026',
  keys: { 'primary-2026': key },
});

describe('credential vault', () => {
  it('round-trips a credential through a fresh authenticated envelope', () => {
    const first = encryptCredential(vault, 'gsk_secret-value');
    const second = encryptCredential(vault, 'gsk_secret-value');

    expect(first.encryptedValue.equals(second.encryptedValue)).toBe(false);
    expect(decryptCredential(vault, first)).toBe('gsk_secret-value');
  });

  it('rejects an unavailable key and a tampered envelope', () => {
    const encrypted = encryptCredential(vault, 'gsk_secret-value');
    const lastByte = encrypted.encryptedValue.at(-1);
    if (lastByte === undefined) {
      throw new Error('Encrypted credential is missing ciphertext.');
    }
    encrypted.encryptedValue.writeUInt8(
      lastByte ^ 1,
      encrypted.encryptedValue.length - 1,
    );

    expect(() => decryptCredential(vault, encrypted)).toThrow(
      'Could not decrypt the provider credential.',
    );
    expect(() =>
      createCredentialVault({
        activeKeyId: 'missing',
        keys: { 'primary-2026': key },
      }),
    ).toThrow('The active encryption key must be configured.');
  });

  it('passes only the encrypted value to PostgreSQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'credential-id' }] });
    const credential = 'gsk_secret-value';

    await expect(
      storeProviderCredential({ query }, vault, {
        repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
        provider: 'groq',
        credential,
      }),
    ).resolves.toBe('credential-id');

    const call = query.mock.calls[0];
    if (call === undefined) {
      throw new Error('Credential storage did not issue a query.');
    }
    const [sql, values] = call;
    expect(sql).toContain('ON CONFLICT (repository_id, provider)');
    expect(sql).not.toContain(credential);
    expect(values).toMatchObject([
      '3d963b52-8203-4ba6-bcac-15bf132371f0',
      'groq',
      'primary-2026',
      expect.any(Buffer),
    ]);
    expect(values[3].includes(credential)).toBe(false);
  });
});
