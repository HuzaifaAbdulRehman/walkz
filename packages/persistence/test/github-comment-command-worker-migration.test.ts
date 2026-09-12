import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/014_github_comment_command_workers.js',
  import.meta.url,
);

describe('GitHub comment command worker migration', () => {
  it('adds leased recovery and durable review binding without source text', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('github_comment_commands_recovery_idx');
    expect(migration).toContain('CREATE INDEX CONCURRENTLY');
    expect(migration).toContain('lease_expires_at');
    expect(migration).toContain('review_run_id uuid UNIQUE');
    expect(migration).not.toContain('comment_body');
    expect(migration).not.toContain('raw_body');
  });

  it('keeps the forward-only migration bounded by a lock timeout', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).toContain('RESET lock_timeout');
    expect(migration).toContain('pgm.noTransaction()');
    expect(migration).toContain('export const down = false');
  });
});
