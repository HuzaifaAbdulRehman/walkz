import { describe, expect, it } from 'vitest';

import {
  loadProviderCredentialStatus,
  parseProviderCredentialConnection,
  providerCredentialErrorMessage,
} from './provider-credentials.js';

describe('provider credential dashboard boundary', () => {
  it('loads only the connection status', async () => {
    const fetcher = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      expect(String(input)).toBe(
        'https://api.example.test/api/repositories/repo-1/provider-credentials/groq',
      );
      expect(init?.headers).toEqual({ cookie: 'walkz_session=session-1' });
      return new Response(JSON.stringify({ provider: 'groq', connected: true }), {
        status: 200,
      });
    };

    await expect(loadProviderCredentialStatus(
      'https://api.example.test/',
      'repo-1',
      'walkz_session=session-1',
      fetcher,
    )).resolves.toEqual({ provider: 'groq', connected: true });
  });

  it('rejects a response that contains no valid status', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      provider: 'groq',
      connected: true,
      apiKey: 'gsk_should-not-be-here',
    }), { status: 200 });

    await expect(loadProviderCredentialStatus(
      'https://api.example.test',
      'repo-1',
      undefined,
      fetcher,
    )).rejects.toThrow('Provider credential response was invalid.');
  });

  it('validates a successful connection response', () => {
    expect(parseProviderCredentialConnection({
      provider: 'groq',
      connected: true,
      selectedModel: 'openai/gpt-oss-20b',
    })).toEqual({
      provider: 'groq',
      connected: true,
      selectedModel: 'openai/gpt-oss-20b',
    });
    expect(() => parseProviderCredentialConnection({
      provider: 'groq',
      connected: true,
    })).toThrow('Provider credential response was invalid.');
  });

  it('turns safe API codes into recovery messages', () => {
    expect(providerCredentialErrorMessage({ error: 'provider_credential_rejected' }))
      .toBe('Groq rejected that key. Check it or create a new one.');
    expect(providerCredentialErrorMessage({ error: 'provider_verification_unavailable' }))
      .toBe('Groq could not verify the key right now. Try again.');
    expect(providerCredentialErrorMessage({ error: 'unknown' }))
      .toBe('Walkz could not update the key. Try again.');
  });
});
