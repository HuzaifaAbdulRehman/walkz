import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../../migrations/020_operational_telemetry_index.js',
  import.meta.url,
));

describe('operational telemetry migration', () => {
  it('adds a concurrent time-window index without private columns', () => {
    const ddl = readFileSync(migrationPath, 'utf8');

    expect(ddl).toContain('pgm.noTransaction()');
    expect(ddl).toContain("SET lock_timeout = '5s'");
    expect(ddl).toContain('CREATE INDEX CONCURRENTLY');
    expect(ddl).toContain('ON review_runs (created_at DESC)');
    expect(ddl).toContain('INCLUDE (status, verdict)');
    expect(ddl).not.toMatch(/summary|payload|prompt|response|credential|source/i);
  });
});
