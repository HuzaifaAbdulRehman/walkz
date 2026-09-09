import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { OAuthStateSigner } from '@walkz/github';

import { readSessionCookie } from './session-auth.js';

const callbackQuerySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
}).strict();

export interface GitHubOAuthClient {
  exchangeCode(code: string): Promise<{ accessToken: string }>;
}

export interface GitHubSessionIssuer {
  create(accessToken: string): Promise<{ sessionId: string; expiresAt: Date }>;
  revoke(sessionId: string): Promise<boolean>;
}

export interface GitHubOAuthStateStore {
  store(input: { stateId: string; expiresAt: Date }): Promise<void>;
  consume(input: { stateId: string; now: Date }): Promise<boolean>;
}

export interface GitHubAuthApiOptions {
  stateSigner: OAuthStateSigner;
  oauthClient: GitHubOAuthClient;
  sessionIssuer: GitHubSessionIssuer;
  stateStore: GitHubOAuthStateStore;
  clientId: string;
  callbackUrl: string;
  now?: () => Date;
}

const sessionCookieName = 'walkz_session';

export function registerGitHubAuthRoutes(
  app: FastifyInstance,
  options: GitHubAuthApiOptions,
): void {
  if (options.clientId.trim().length === 0 || options.callbackUrl.trim().length === 0) {
    throw new Error('GitHub OAuth client configuration is required.');
  }
  const callbackUrl = new URL(options.callbackUrl);
  if (callbackUrl.protocol !== 'https:' && callbackUrl.hostname !== 'localhost') {
    throw new Error('GitHub OAuth callbacks must use HTTPS outside localhost.');
  }
  const now = options.now ?? (() => new Date());
  app.get('/auth/github/start', async (_request, reply) => {
    const stateId = randomUUID();
    const state = options.stateSigner.issue({ stateId, returnTo: '/' });
    await options.stateStore.store({ stateId, expiresAt: new Date(state.expiresAt) });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', callbackUrl.toString());
    url.searchParams.set('state', state.token);
    return reply.redirect(url.toString());
  });
  app.get('/auth/github/callback', async (request, reply) => {
    const parsedQuery = callbackQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: 'oauth_state_invalid' });
    let state: { stateId: string; returnTo: string };
    try {
      state = options.stateSigner.verify(parsedQuery.data.state);
    } catch {
      return reply.code(400).send({ error: 'oauth_state_invalid' });
    }
    let stateConsumed: boolean;
    try {
      stateConsumed = await options.stateStore.consume({ stateId: state.stateId, now: now() });
    } catch {
      return reply.code(503).send({ error: 'authentication_unavailable' });
    }
    if (!stateConsumed) return reply.code(400).send({ error: 'oauth_state_invalid' });
    try {
      const { accessToken } = await options.oauthClient.exchangeCode(parsedQuery.data.code);
      const session = await options.sessionIssuer.create(accessToken);
      const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - now().getTime()) / 1_000));
      return reply
        .header(
          'set-cookie',
          `${sessionCookieName}=${encodeURIComponent(session.sessionId)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        )
        .redirect(state.returnTo);
    } catch {
      return reply.code(502).send({ error: 'github_authentication_failed' });
    }
  });
  app.post('/auth/logout', async (request, reply) => {
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId !== undefined) {
      try {
        await options.sessionIssuer.revoke(sessionId);
      } catch {
        return reply.code(503).send({ error: 'logout_unavailable' });
      }
    }
    return reply
      .header(
        'set-cookie',
        `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      )
      .code(204)
      .send();
  });
}

export function createGitHubAuthApi(options: GitHubAuthApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerGitHubAuthRoutes(app, options);
  return app;
}
