import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseReleaseOptions } from './build-release.mjs';

describe('release build options', () => {
  it('keeps the generated manifest inside the repository', () => {
    expect(parseReleaseOptions([]).outputPath).toMatch(
      /artifacts[\\/]release-manifest\.json$/,
    );
    expect(() => parseReleaseOptions([
      '--output',
      '../outside.json',
    ])).toThrow(/inside the repository/);
  });

  it('requires an explicit override for development builds', () => {
    expect(parseReleaseOptions(['--allow-dirty']).allowDirty).toBe(true);
    expect(parseReleaseOptions([]).allowDirty).toBe(false);
  });

  it('uses the pinned Alpine branch for worker packages and excludes credentials', async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile(resolve('infra', 'Dockerfile'), 'utf8'),
      readFile('.dockerignore', 'utf8'),
    ]);
    expect(dockerfile).toMatch(/apk add --no-cache git ca-certificates docker-cli/);
    expect(dockerfile).not.toMatch(/apk add --no-cache [^\n]*\w+=\d/);
    for (const pattern of ['**/.env', '**/.npmrc', '**/*.pem', '**/*.key']) {
      expect(dockerignore.split(/\r?\n/)).toContain(pattern);
    }
  });
});
