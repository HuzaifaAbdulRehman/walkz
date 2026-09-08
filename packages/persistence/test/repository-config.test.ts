import { describe, expect, it, vi } from 'vitest';

import {
  listRepositoryConfigVersions,
  saveRepositoryConfig,
} from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const input = {
  repositoryId,
  schemaVersion: 1,
  configHash: 'a'.repeat(64),
  config: { provider: 'groq', blockingEvidenceLevels: ['VERIFIED'] },
};

describe('repository configuration history', () => {
  it('does not overwrite an existing immutable config version', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(saveRepositoryConfig({ query }, input)).resolves.toBe('existing');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (repository_id, config_hash) DO NOTHING'),
      [repositoryId, 1, 'a'.repeat(64), JSON.stringify(input.config)],
    );
  });

  it('lists config versions newest first', async () => {
    const rows = [{ id: 'config-id', repositoryId, schemaVersion: 1 }];
    const query = vi.fn().mockResolvedValue({ rows });

    await expect(listRepositoryConfigVersions({ query }, repositoryId)).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at DESC'), [repositoryId]);
  });
});
