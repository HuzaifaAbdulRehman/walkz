import type { StructuredPatchRequest } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import { requestStructuredPatch } from '../src/index.js';

const apiKey = 'groq-test-key';
const model = 'openai/gpt-oss-120b';
const request: StructuredPatchRequest = {
  model,
  systemPrompt: 'Generate one bounded replacement.',
  userPrompt: '{"findingId":"15d3e79e-02eb-42c3-91c5-0e48c4b5bf68"}',
  maxOutputTokens: 1_000,
  promptVersion: 'walkz-patch-v1',
};
const patch = {
  findingId: '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68',
  headSha: 'b'.repeat(40),
  path: 'src/a.ts',
  startLine: 4,
  endLine: 4,
  replacement: 'return value ?? fallback;',
  approvalRequired: true,
} as const;

function completion(content: unknown = patch): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-patch-1',
    model,
    choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify(content) },
    }],
    usage: {
      prompt_tokens: 80,
      completion_tokens: 20,
      total_tokens: 100,
    },
  }), { status: 200 });
}

describe('Groq structured patch generation', () => {
  it('sends a strict approval-gated schema without tools', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: unknown;
        response_format: {
          json_schema: {
            strict: boolean;
            name: string;
            schema: {
              additionalProperties: boolean;
              properties: { approvalRequired: { enum: boolean[] } };
            };
          };
        };
      };
      expect(body).not.toHaveProperty('tools');
      expect(body.response_format.json_schema).toMatchObject({
        strict: true,
        name: 'walkz_patch_v1',
      });
      expect(
        body.response_format.json_schema.schema.properties.approvalRequired,
      ).toEqual({ type: 'boolean', enum: [true] });
      expect(
        body.response_format.json_schema.schema.additionalProperties,
      ).toBe(false);
      return completion();
    });

    await expect(requestStructuredPatch(request, {
      apiKey,
      fetch: fetchMock,
      monotonicNow: () => 10,
    })).resolves.toMatchObject({
      provider: 'groq',
      model,
      promptVersion: 'walkz-patch-v1',
      schemaVersion: 'walkz-patch-v1',
      patch,
    });
  });

  it('rejects malformed patch content without repairing it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => completion({
      ...patch,
      approvalRequired: false,
    }));

    await expect(requestStructuredPatch(request, {
      apiKey,
      fetch: fetchMock,
      maxAttempts: 1,
    })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it('uses the bounded retry policy for transient failures', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'busy' } }),
        { status: 503 },
      ))
      .mockResolvedValueOnce(completion());

    await expect(requestStructuredPatch(request, {
      apiKey,
      fetch: fetchMock,
      maxAttempts: 2,
      random: () => 0,
      sleep,
    })).resolves.toMatchObject({ patch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
