import { describe, expect, it, vi } from 'vitest';

import { proxyToHostedApi } from './hosted-api-proxy.js';

describe('hosted API proxy', () => {
  it('preserves OAuth redirects and session cookies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: {
        location: '/',
        'set-cookie': 'walkz_session=session; Path=/; HttpOnly; Secure; SameSite=Lax',
      },
    }));
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/auth/github/callback?code=a&state=b'),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['auth', 'github', 'callback'],
        fetcher,
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie')).toContain('walkz_session=session');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://api:3001/auth/github/callback?code=a&state=b'),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('forwards webhook bytes and signature metadata unchanged', async () => {
    const payload = Buffer.from('{"message":"caf\u00e9"}', 'utf8');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(Buffer.from(init?.body as Buffer)).toEqual(payload);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-github-delivery')).toBe('delivery-1');
      expect(headers.get('x-github-event')).toBe('pull_request');
      expect(headers.get('x-hub-signature-256')).toBe('sha256=abc');
      expect(headers.get('authorization')).toBeNull();
      return Response.json({ accepted: true }, { status: 202 });
    });
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/webhooks/github', {
        method: 'POST',
        body: payload,
        headers: {
          authorization: 'must-not-cross-the-boundary',
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=abc',
        },
      }),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['webhooks', 'github'],
        fetcher,
      },
    );

    expect(response.status).toBe(202);
  });

  it('encodes route segments and forwards only approved API headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(url.toString()).toBe('http://api:3001/api/repositories/repo%20one?limit=10');
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe('walkz_session=session');
      expect(headers.get('idempotency-key')).toBe('request-id');
      expect(headers.get('x-forwarded-host')).toBeNull();
      return Response.json({ ok: true });
    });
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/api/repositories/repo%20one?limit=10', {
        headers: {
          cookie: 'analytics=private; walkz_session=session; preferences=private',
          'idempotency-key': 'request-id',
          'x-forwarded-host': 'attacker.example',
        },
      }),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['api', 'repositories', 'repo one'],
        fetcher,
      },
    );

    expect(response.status).toBe(200);
  });

  it('rejects oversized bodies before contacting the API', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/webhooks/github', {
        method: 'POST',
        body: 'small',
        headers: { 'content-length': '1048577' },
      }),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['webhooks', 'github'],
        fetcher,
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'gateway_body_too_large' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops reading a chunked body at the gateway limit', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/webhooks/github', {
        method: 'POST',
        body: 'x'.repeat(1_048_577),
      }),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['webhooks', 'github'],
        fetcher,
      },
    );

    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects dot segments instead of normalizing another API route', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/api/%2e%2e/auth'),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['api', '..', 'auth'],
        fetcher,
      },
    );

    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsafe API configuration without making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/api/installations'),
      {
        apiUrl: 'http://user:secret@api:3001',
        pathSegments: ['api', 'installations'],
        fetcher,
      },
    );

    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a bounded gateway error when the API is unreachable', async () => {
    const response = await proxyToHostedApi(
      new Request('https://walkz.example/auth/github/start'),
      {
        apiUrl: 'http://api:3001',
        pathSegments: ['auth', 'github', 'start'],
        fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('connection details')),
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'hosted_api_request_failed' });
  });
});
