import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const packageJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
const require = createRequire(import.meta.url);
const { up: createCompletedCheckIndex } = require('../../../migrations/004_completed_check_idempotency.js') as {
  up: (pgm: { noTransaction: () => void; sql: (statement: string) => void }) => void;
};

describe('migration command', () => {
  it('does not wrap concurrent-index migrations in one transaction', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['migrate:up']).toContain('--no-single-transaction');
  });

  it('sends the concurrent index in its own query', () => {
    const pgm = { noTransaction: vi.fn(), sql: vi.fn() };

    createCompletedCheckIndex(pgm);

    expect(pgm.noTransaction).toHaveBeenCalledOnce();
    expect(pgm.sql).toHaveBeenCalledTimes(3);
    expect(pgm.sql.mock.calls[1]?.[0]).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
  });
});
