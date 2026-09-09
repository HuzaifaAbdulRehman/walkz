import { z } from 'zod';

import type { SessionPrincipal } from '@walkz/persistence';

const requestSchema = z.object({
  headers: z.object({ cookie: z.string().optional() }).loose(),
}).loose();

export interface SessionVerifier {
  authenticate(sessionId: string): Promise<SessionPrincipal | null>;
}

export interface ApiSessionAuthenticator {
  authenticate(request: unknown): Promise<SessionPrincipal | null>;
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const item of cookieHeader.split(';')) {
    const [name, ...valueParts] = item.trim().split('=');
    if (name !== 'walkz_session') continue;
    try {
      return decodeURIComponent(valueParts.join('='));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createApiSessionAuthenticator(
  sessions: SessionVerifier,
): ApiSessionAuthenticator {
  return {
    async authenticate(input) {
      const request = requestSchema.safeParse(input);
      if (!request.success) return null;
      const sessionId = readSessionCookie(request.data.headers.cookie);
      if (sessionId === undefined) return null;
      try {
        return await sessions.authenticate(sessionId);
      } catch {
        return null;
      }
    },
  };
}
