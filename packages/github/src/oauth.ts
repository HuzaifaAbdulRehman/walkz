import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const oauthPayloadSchema = z
  .object({
    stateId: z.uuid(),
    returnTo: z.string().regex(/^\/[A-Za-z0-9_/?=&%.-]*$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const oauthStateTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export interface OAuthStateSigner {
  issue(input: { stateId: string; returnTo: string }): {
    token: string;
    expiresAt: number;
  };
  verify(token: string): { stateId: string; returnTo: string };
}

export function createOAuthStateSigner(
  secret: string,
  options: { ttlMs?: number; now?: () => number } = {},
): OAuthStateSigner {
  if (secret.length < 32) {
    throw new Error('OAuth state secret must be at least 32 characters.');
  }
  const ttlMs = options.ttlMs ?? 600_000;
  const now = options.now ?? Date.now;

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  return {
    issue(input) {
      const payload = oauthPayloadSchema.parse({
        stateId: input.stateId,
        returnTo: input.returnTo,
        issuedAt: now(),
        expiresAt: now() + ttlMs,
      });
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return { token: `${encoded}.${sign(encoded)}`, expiresAt: payload.expiresAt };
    },
    verify(token) {
      const parsedToken = oauthStateTokenSchema.parse(token);
      const [encoded, receivedSignature] = parsedToken.split('.');
      if (encoded === undefined || receivedSignature === undefined) {
        throw new Error('OAuth state is malformed.');
      }
      const expected = Buffer.from(sign(encoded));
      const received = Buffer.from(receivedSignature);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        throw new Error('OAuth state signature is invalid.');
      }
      const payload = oauthPayloadSchema.parse(
        JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      );
      if (payload.expiresAt <= now()) {
        throw new Error('OAuth state has expired.');
      }
      return { stateId: payload.stateId, returnTo: payload.returnTo };
    },
  };
}
