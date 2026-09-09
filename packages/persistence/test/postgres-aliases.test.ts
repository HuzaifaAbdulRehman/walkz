import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const unquotedCamelCaseAlias = /\bAS\s+(?!")[A-Za-z_]*[A-Z][A-Za-z_]*/;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? collectTypeScriptFiles(path)
      : entry.isFile() && path.endsWith('.ts') ? [path] : [];
  }));
  return files.flat();
}

describe('PostgreSQL aliases', () => {
  it('quotes every camel-case alias used by persistence SQL', async () => {
    const files = await collectTypeScriptFiles(packageRoot);
    const offenders = (await Promise.all(files.map(async (path) => {
      const source = await readFile(path, 'utf8');
      return unquotedCamelCaseAlias.test(source) ? path : null;
    }))).filter((path): path is string => path !== null);

    expect(offenders).toEqual([]);
  });
});
