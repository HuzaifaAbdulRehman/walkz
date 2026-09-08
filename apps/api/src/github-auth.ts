import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { OAuthStateSigner } from '@walkz/github';

const callbackQuerySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
}).strict();

export interface GitHubOAuthClient {
  exchangeCode(code: string): Promise<{ accessToken: string }>;
}

export interface GitHubSessionIssuer {
  create(accessToken: string): Promise<{ sessionId: string }>;
}

export interface GitHubAuthApiOptions {
  stateSigner: OAuthStateSigner;
  oauthClient: GitHubOAuthClient;
  sessionIssuer: GitHubSessionIssuer;
  clientId: string;
  callbackUrl: string;
}

export function createGitHubAuthApi(options: GitHubAuthApiOptions): FastifyInstance {
  if (options.clientId.trim().length === 0 || options.callbackUrl.trim().length === 0) {
    throw new Error('GitHub OAuth client configuration is required.');
  }
  const app = Fastify({ logger: false });
  app.get('/auth/github/start', async (_request, reply) => {
    const state = options.stateSigner.issue({ stateId: randomUUID(), returnTo: '/reviews' });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.callbackUrl);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });
  app.get('/auth/github/callback', async (request, reply) => {
    const query = callbackQuerySchema.parse(request.query);
    const state = options.stateSigner.consume(query.state);
    const { accessToken } = await options.oauthClient.exchangeCode(query.code);
    const session = await options.sessionIssuer.create(accessToken);
    return reply
      .header(
        'set-cookie',
        `walkz_session=${encodeURIComponent(session.sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      )
      .redirect(state.returnTo);
  });
  return app;
}
