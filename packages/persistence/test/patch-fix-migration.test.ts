import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../../migrations/012_hosted_patch_fix_jobs.js',
  import.meta.url,
));

describe('hosted patch fix jobs migration', () => {
  it('stores only fix metadata and protects queue recovery', () => {
    const ddl = readFileSync(migrationPath, 'utf8');

    expect(ddl).toContain('CREATE TABLE patch_fix_jobs');
    expect(ddl).toContain('proof_plan_digest char(64)');
    expect(ddl).toContain('proof_command_digest char(64)');
    expect(ddl).toContain('patch_fix_jobs_lease_pair_check');
    expect(ddl).toContain('outbox_patch_fix_queued_key');
    expect(ddl).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(ddl).not.toContain('replacement');
    expect(ddl).not.toContain('patch_text');
  });
});
