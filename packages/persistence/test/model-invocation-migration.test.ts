import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const telemetryMigrationPath = fileURLToPath(new URL(
  '../../../migrations/017_model_invocation_telemetry.js',
  import.meta.url,
));
const indexMigrationPath = fileURLToPath(new URL(
  '../../../migrations/018_model_invocation_idempotency_index.js',
  import.meta.url,
));

describe('model invocation telemetry migration', () => {
  it('adds bounded outcomes and an idempotency key without raw payloads', () => {
    const telemetryDdl = readFileSync(telemetryMigrationPath, 'utf8');
    const indexDdl = readFileSync(indexMigrationPath, 'utf8');

    expect(telemetryDdl).not.toContain('pgm.noTransaction()');
    expect(telemetryDdl).toContain("SET LOCAL lock_timeout = '5s'");
    expect(telemetryDdl).toContain("stage IN ('review', 'patch', 'challenger', 'security')");
    expect(telemetryDdl).toContain("status IN ('succeeded', 'failed')");
    expect(telemetryDdl).toContain('attempt_count > 0');
    expect(telemetryDdl).toContain('NOT VALID');
    expect(telemetryDdl).toContain('VALIDATE CONSTRAINT');
    expect(indexDdl).toContain('pgm.noTransaction()');
    expect(indexDdl.match(/pgm\.sql\(/g)).toHaveLength(2);
    expect(indexDdl).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
    expect(indexDdl).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(`${telemetryDdl}\n${indexDdl}`).not.toContain('raw_prompt');
    expect(`${telemetryDdl}\n${indexDdl}`).not.toContain('raw_response');
    expect(`${telemetryDdl}\n${indexDdl}`).not.toContain('source_code');
  });
});
