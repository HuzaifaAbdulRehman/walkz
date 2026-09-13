import type { StructuredChallengeRequest } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import { requestStructuredChallenge } from '../src/index.js';

const model = 'openai/gpt-oss-20b';
const fingerprint = 'a'.repeat(64);
const request: StructuredChallengeRequest = {
  model,
  systemPrompt: 'Challenge only the supplied findings.',
  userPrompt: JSON.stringify({ findings: [{ fingerprint }] }),
  maxOutputTokens: 1_000,
  promptVersion: 'walkz-challenge-v1',
};

function response(content: unknown): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-challenge-1',
    model,
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(content) },
    }],
    usage: {
      prompt_tokens: 30,
      completion_tokens: 12,
      total_tokens: 42,
    },
  }), { status: 200 });
}

describe('Groq structured challenge', () => {
  it('sends a strict, tool-free schema and validates the decision', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: unknown;
        response_format: {
          json_schema: {
            name: string;
            strict: boolean;
            schema: {
              additionalProperties: boolean;
              properties: {
                decisions: { items: { required: string[] } };
              };
            };
          };
        };
      };
      expect(body).not.toHaveProperty('tools');
      expect(body.response_format.json_schema).toMatchObject({
        name: 'walkz_challenge_v1',
        strict: true,
      });
      expect(body.response_format.json_schema.schema.additionalProperties)
        .toBe(false);
      expect(
        body.response_format.json_schema.schema.properties.decisions.items
          .required,
      ).toEqual(['findingFingerprint', 'rationale', 'verdict']);
      return response({
        decisions: [{
          findingFingerprint: fingerprint,
          verdict: 'uphold',
          rationale: 'The counterexample still applies.',
        }],
      });
    });

    await expect(requestStructuredChallenge(request, {
      apiKey: 'groq-test-key',
      fetch: fetchMock,
      monotonicNow: () => 0,
    })).resolves.toMatchObject({
      provider: 'groq',
      model,
      schemaVersion: 'walkz-challenge-v1',
      challenge: {
        decisions: [{
          findingFingerprint: fingerprint,
          verdict: 'uphold',
        }],
      },
      usage: { totalTokens: 42 },
    });
  });

  it('rejects duplicate decisions returned by the provider', async () => {
    const decision = {
      findingFingerprint: fingerprint,
      verdict: 'dispute',
      rationale: 'The claim does not follow.',
    };
    const fetchMock = vi.fn<typeof fetch>(async () => response({
      decisions: [decision, decision],
    }));

    await expect(requestStructuredChallenge(request, {
      apiKey: 'groq-test-key',
      fetch: fetchMock,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
