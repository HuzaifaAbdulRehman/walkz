import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../../migrations/013_bind_proof_evidence.js',
  import.meta.url,
));

describe('proof evidence binding migration', () => {
  it('adds indexed proof provenance without storing proof input', () => {
    const ddl = readFileSync(migrationPath, 'utf8');

    expect(ddl).toContain('ADD COLUMN plan_digest char(64)');
    expect(ddl).toContain('ADD COLUMN base_outcome text');
    expect(ddl).toContain('ADD COLUMN head_outcome text');
    expect(ddl).toContain(
      "reproof_result->'proof'->>'planDigest' = plan_digest::text",
    );
    expect(ddl).toContain(
      "reproof_result->'proof'->>'outcome' = head_outcome",
    );
    expect(ddl).toContain('evidence_counterfactual_binding_idx');
    expect(ddl).not.toMatch(/proof_(?:plan|file|source|prompt) jsonb/iu);
  });
});
