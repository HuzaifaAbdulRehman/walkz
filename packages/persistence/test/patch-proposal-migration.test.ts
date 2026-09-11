import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { up: addPatchProposalContracts } = require(
  '../../../migrations/009_patch_proposal_contracts.js',
) as {
  up: (pgm: { sql: (statement: string) => void }) => void;
};

describe('patch proposal contracts migration', () => {
  it('binds proposals to revisions, findings, and decision metadata', () => {
    const pgm = { sql: vi.fn() };

    addPatchProposalContracts(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain("lock_timeout = '5s'");
    const ddl = String(pgm.sql.mock.calls[1]?.[0]);
    expect(ddl).toContain('patch_proposals must be empty');
    expect(ddl).toContain('ADD COLUMN base_sha char(40) NOT NULL');
    expect(ddl).toContain('patch_proposals_decision_metadata_check');
    expect(ddl).toContain('patch_proposals_timestamps_check');
    expect(ddl).toContain('patch_proposals_review_run_revision_fkey');
    expect(ddl).toContain('patch_proposals_finding_run_fkey');
    expect(ddl).not.toContain('UPDATE patch_proposals');
    expect(ddl).not.toContain('patch_text');
    expect(pgm.sql.mock.calls[2]?.[0]).toContain('RESET lock_timeout');
  });
});
