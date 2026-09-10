import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHostedEnvironment,
  parsePublicUrl,
  writeHostedEnvironment,
} from './init-hosted-env.mjs';

const template = `POSTGRES_PASSWORD=replace-password
GITHUB_OAUTH_CALLBACK_URL=https://replace-me.example/auth/github/callback
GITHUB_WEBHOOK_SECRET=replace-webhook
WALKZ_OAUTH_STATE_SECRET=replace-oauth
WALKZ_CREDENTIAL_KEYS_JSON={"local-2026":"replace-key"}
`;

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('hosted environment setup', () => {
  it('accepts only a public HTTPS origin', () => {
    expect(parsePublicUrl('https://walkz.example/')).toBe('https://walkz.example');
    for (const value of [
      'http://walkz.example',
      'https://localhost',
      'https://user:secret@walkz.example',
      'https://walkz.example/path',
      'https://walkz.example?mode=test',
    ]) {
      expect(() => parsePublicUrl(value)).toThrow();
    }
  });

  it('fills callback routes and independent 32-byte secrets', () => {
    let byte = 0;
    const output = buildHostedEnvironment(
      template,
      'https://walkz.example',
      (size) => Buffer.alloc(size, ++byte),
    );

    expect(output).toContain(
      'GITHUB_OAUTH_CALLBACK_URL=https://walkz.example/auth/github/callback',
    );
    expect(output).not.toContain('replace-');
    const values = Object.fromEntries(output.trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    expect(values.POSTGRES_PASSWORD).toHaveLength(43);
    expect(values.GITHUB_WEBHOOK_SECRET).toHaveLength(43);
    expect(values.WALKZ_OAUTH_STATE_SECRET).toHaveLength(43);
    expect(JSON.parse(values.WALKZ_CREDENTIAL_KEYS_JSON)['local-2026']).toHaveLength(44);
    expect(new Set([
      values.POSTGRES_PASSWORD,
      values.GITHUB_WEBHOOK_SECRET,
      values.WALKZ_OAUTH_STATE_SECRET,
    ])).toHaveLength(3);
  });

  it('creates the file once and refuses to overwrite it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'walkz-hosted-env-'));
    temporaryDirectories.push(directory);
    const templatePath = join(directory, 'template');
    const outputPath = join(directory, '.env');
    await writeFile(templatePath, template, 'utf8');
    const options = {
      templatePath,
      outputPath,
      publicUrl: 'https://walkz.example',
      randomSource: (size) => Buffer.alloc(size, 7),
    };

    await writeHostedEnvironment(options);
    await expect(readFile(outputPath, 'utf8')).resolves.toContain(
      'GITHUB_WEBHOOK_SECRET=',
    );
    await expect(writeHostedEnvironment(options)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
