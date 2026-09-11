import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { up: addPatchReproofEvidence } = require(
  '../../../migrations/011_patch_reproof_evidence.js',
) as {
  up: (pgm: { sql: (statement: string) => void }) => void;
};

describe('patch reproof evidence migration', () => {
  it('binds hash-only reproof outcomes to an exact proposal attempt', () => {
    const pgm = { sql: vi.fn(), noTransaction: vi.fn() };

    addPatchReproofEvidence(pgm);

    expect(pgm.noTransaction).toHaveBeenCalledOnce();
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("lock_timeout = '5s'");
    const ddl = pgm.sql.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(ddl).toContain('patch_proposals_reproof_identity_key');
    expect(ddl).toContain('evidence_reproof_metadata_check');
    expect(ddl).toContain('evidence_reproof_result_binding_check');
    expect(ddl).toContain('evidence_reproof_finding_fkey');
    expect(ddl).toContain('evidence_reproof_proposal_fkey');
    expect(ddl).toContain('evidence_patch_reproof_attempt_key');
    expect(ddl).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(ddl).toContain('NOT VALID');
    expect(ddl).toContain('VALIDATE CONSTRAINT');
    expect(ddl).not.toContain('patch_text');
    expect(ddl).not.toContain('replacement');
    expect(pgm.sql.mock.calls.at(-1)?.[0]).toContain('RESET lock_timeout');
  });
});
