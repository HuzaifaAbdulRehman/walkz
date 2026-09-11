import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { up: addPatchPublicationLease } = require(
  '../../../migrations/010_patch_publication_lease.js',
) as {
  up: (pgm: { sql: (statement: string) => void }) => void;
};

describe('patch publication lease migration', () => {
  it('adds a paired, expiring lease without storing patch content', () => {
    const pgm = { sql: vi.fn() };

    addPatchPublicationLease(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain("lock_timeout = '5s'");
    const ddl = String(pgm.sql.mock.calls[1]?.[0]);
    expect(ddl).toContain('ADD COLUMN publication_lease_owner uuid');
    expect(ddl).toContain('ADD COLUMN publication_lease_expires_at timestamptz');
    expect(ddl).toContain('patch_proposals_publication_lease_pair_check');
    expect(ddl).toContain('patch_proposals_publication_lease_idx');
    expect(ddl).not.toContain('patch_text');
    expect(pgm.sql.mock.calls[2]?.[0]).toContain('RESET lock_timeout');
  });
});
