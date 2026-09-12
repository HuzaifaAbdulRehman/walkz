import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../../migrations/016_pending_patch_suggestions.js',
  import.meta.url,
));

describe('pending patch suggestion migration', () => {
  it('allows durable suggestions before approval but never after rejection', () => {
    const ddl = readFileSync(migrationPath, 'utf8');

    expect(ddl).toContain("approval_status IN ('pending', 'approved')");
    expect(ddl).toContain('NOT VALID');
    expect(ddl).toContain('VALIDATE CONSTRAINT');
    expect(ddl).not.toContain("approval_status IN ('pending', 'approved', 'rejected')");
    expect(ddl).not.toContain('replacement');
    expect(ddl).not.toContain('patch_text');
  });
});
