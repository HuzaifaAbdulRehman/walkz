import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { up: addStructuredFindings } = require(
  '../../../migrations/008_structured_findings.js',
) as {
  up: (pgm: {
    noTransaction: () => void;
    sql: (statement: string) => void;
  }) => void;
};

describe('structured findings migration', () => {
  it('uses bounded DDL and a concurrent review-run index', () => {
    const pgm = { noTransaction: vi.fn(), sql: vi.fn() };

    addStructuredFindings(pgm);

    expect(pgm.noTransaction).toHaveBeenCalledOnce();
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("lock_timeout = '5s'");
    expect(pgm.sql.mock.calls[1]?.[0]).toContain('ADD COLUMN category');
    expect(pgm.sql.mock.calls[2]?.[0]).toContain('CREATE INDEX CONCURRENTLY');
    expect(pgm.sql.mock.calls[3]?.[0]).toContain('RESET lock_timeout');
  });
});
