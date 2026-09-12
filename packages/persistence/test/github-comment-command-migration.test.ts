import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../migrations/013_github_comment_commands.js', import.meta.url),
  'utf8',
);

describe('GitHub comment command migration', () => {
  it('stores bounded command metadata without raw comment text', () => {
    expect(migration).toContain('CREATE TABLE github_comment_commands');
    expect(migration).toContain('webhook_delivery_id uuid NOT NULL UNIQUE');
    expect(migration).toContain("command IN ('review', 'propose_fix')");
    expect(migration).toContain('github_comment_commands_terminal_status_guard');
    expect(migration).toContain('outbox_github_comment_command_queued_key');
    expect(migration).not.toMatch(/comment_body|raw_body|payload\s+jsonb/i);
  });

  it('is forward-only and bounds schema locking', () => {
    expect(migration).toContain('export const down = false');
    expect(migration).toContain('SET lock_timeout');
    expect(migration).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
  });
});
