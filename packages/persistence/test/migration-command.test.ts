import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));

describe('migration command', () => {
  it('does not wrap concurrent-index migrations in one transaction', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['migrate:up']).toContain('--no-single-transaction');
  });
});
