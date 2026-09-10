import { describe, expect, it, vi } from 'vitest';

import {
  createCredentialVault,
  deleteProviderCredential,
  decryptCredential,
  encryptCredential,
  hasProviderCredential,
  loadProviderCredential,
  storeProviderCredential,
} from '../src/index.js';

const key = Buffer.alloc(32, 7).toString('base64');
const vault = createCredentialVault({
  activeKeyId: 'primary-2026',
  keys: { 'primary-2026': key },
});
const binding = {
  repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
  provider: 'groq',
};

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

  it('binds new envelopes to one repository and provider', () => {
    const encrypted = encryptCredential(vault, 'gsk_secret-value', binding);

    expect(decryptCredential(vault, encrypted, binding)).toBe('gsk_secret-value');
    expect(() => decryptCredential(vault, encrypted, {
      ...binding,
      provider: 'another-provider',
    })).toThrow('Could not decrypt the provider credential.');
    expect(() => decryptCredential(vault, encrypted)).toThrow(
      'binding is required',
    );
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
    expect(values[3][0]).toBe(2);
  });

  it('loads a credential only through its repository and provider binding', async () => {
    const encrypted = encryptCredential(vault, 'gsk_secret-value', binding);
    const query = vi.fn().mockResolvedValue({ rows: [{
      encryptionKeyId: encrypted.encryptionKeyId,
      encryptedValue: encrypted.encryptedValue,
    }] });

    await expect(loadProviderCredential({ query }, vault, binding)).resolves.toBe(
      'gsk_secret-value',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('repository_id = $1 AND provider = $2'),
      [binding.repositoryId, binding.provider],
    );
  });

  it('returns null when no repository credential exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(loadProviderCredential({ query }, vault, binding)).resolves.toBeNull();
  });

  it('reports credential status without loading encrypted bytes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] });

    await expect(hasProviderCredential({ query }, binding)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT EXISTS'),
      [binding.repositoryId, binding.provider],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('encrypted_value');
  });

  it('returns false when credential status has no matching row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: false }] });

    await expect(hasProviderCredential({ query }, binding)).resolves.toBe(false);
  });

  it('deletes only the bound repository credential', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    await expect(deleteProviderCredential({ query }, binding)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('repository_id = $1 AND provider = $2'),
      [binding.repositoryId, binding.provider],
    );
  });

  it('keeps credential deletion idempotent', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });

    await expect(deleteProviderCredential({ query }, binding)).resolves.toBe(false);
  });
});
