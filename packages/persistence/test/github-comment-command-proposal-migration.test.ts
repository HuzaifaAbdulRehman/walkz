import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/015_github_comment_command_proposals.js',
  import.meta.url,
);

describe('GitHub comment command proposal migration', () => {
  it('links one proposal result without storing candidate text', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('patch_proposal_id uuid UNIQUE');
    expect(migration).toContain('num_nonnulls(review_run_id, patch_proposal_id) = 1');
    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).toContain('export const down = false');
    expect(migration).not.toMatch(/replacement|patch_text|comment_body/iu);
  });
});
