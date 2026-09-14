import { WALKZ_REVIEW_PROMPT_VERSION } from '@walkz/engine';
import { describe, expect, it } from 'vitest';

import { parseHostedApiEnvironment } from '../src/index.js';

const pemLabel = 'PRIVATE KEY';
const privateKey = Buffer.from([
  '-----BEGIN ' + pemLabel + '-----',
  'test-value',
  '-----END ' + pemLabel + '-----',
].join('\n')).toString('base64');
const credentialKey = Buffer.alloc(32, 9).toString('base64');

function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://walkz:secret@postgres:5432/walkz',
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY_BASE64: privateKey,
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    GITHUB_OAUTH_CALLBACK_URL: 'https://walkz.test/auth/github/callback',
    GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
    WALKZ_OAUTH_STATE_SECRET: 's'.repeat(32),
    WALKZ_CREDENTIAL_ACTIVE_KEY_ID: 'primary-2026',
    WALKZ_CREDENTIAL_KEYS_JSON: JSON.stringify({
      'primary-2026': credentialKey,
    }),
  };
}

describe('hosted API runtime configuration', () => {
  it('parses a base64 PEM without retaining the encoded form', () => {
    const parsed = parseHostedApiEnvironment(environment());

    expect(parsed.githubPrivateKey).toContain('BEGIN PRIVATE KEY');
    expect(parsed).not.toHaveProperty('GITHUB_PRIVATE_KEY_BASE64');
    expect(parsed.credentialVault.keys.get('primary-2026')).toEqual(Buffer.alloc(32, 9));
    expect(parsed.port).toBe(3001);
    expect(parsed.host).toBe('0.0.0.0');
    expect(parsed.promptVersion).toBe(WALKZ_REVIEW_PROMPT_VERSION);
  });

  it('does not accept an operator-selected prompt version', () => {
    const parsed = parseHostedApiEnvironment({
      ...environment(),
      WALKZ_PROMPT_VERSION: 'removed-prompt-version',
    });

    expect(parsed.promptVersion).toBe(WALKZ_REVIEW_PROMPT_VERSION);
  });

  it('rejects short webhook and state secrets', () => {
    expect(() => parseHostedApiEnvironment({
      ...environment(),
      GITHUB_WEBHOOK_SECRET: 'short',
      WALKZ_OAUTH_STATE_SECRET: 'short',
    })).toThrow();
  });

  it('rejects decoded values that are not PEM keys', () => {
    expect(() => parseHostedApiEnvironment({
      ...environment(),
      GITHUB_PRIVATE_KEY_BASE64: Buffer.from('not-a-key').toString('base64'),
    })).toThrow('must contain a PEM private key');
  });

  it('rejects invalid credential encryption configuration', () => {
    expect(() => parseHostedApiEnvironment({
      ...environment(),
      WALKZ_CREDENTIAL_KEYS_JSON: 'not-json',
    })).toThrow('must contain a JSON object');
    expect(() => parseHostedApiEnvironment({
      ...environment(),
      WALKZ_CREDENTIAL_ACTIVE_KEY_ID: 'missing',
    })).toThrow('active encryption key');
  });
});
