import {
  createGitHubInstallationApp,
  createGitHubOAuthClient,
  createGitHubUserIdentityClient,
  createInstallationPullRequestReaderFactory,
  createInstallationRepositoryCatalogFactory,
  createOAuthStateSigner,
} from '@walkz/github';
import {
  consumeOAuthState,
  createDatabasePool,
  createPersistentGitHubSessionService,
  listRepositoryConfigVersions,
  listReviewHistory,
  storeOAuthState,
} from '@walkz/persistence';
import { z } from 'zod';

import { createHostedApi } from './hosted-api.js';
import { createPersistentInstallationRepositoryStore } from './installation-store.js';
import { createPersistentManualReviewStarter } from './manual-review-api.js';
import { createApiSessionAuthenticator } from './session-auth.js';
import { createPersistentGitHubWebhookIntake } from './webhook.js';

const base64Schema = z.string().min(1).max(100_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  GITHUB_APP_ID: z.string().trim().min(1).max(128),
  GITHUB_PRIVATE_KEY_BASE64: base64Schema,
  GITHUB_CLIENT_ID: z.string().trim().min(1).max(256),
  GITHUB_CLIENT_SECRET: z.string().trim().min(1).max(1_024),
  GITHUB_OAUTH_CALLBACK_URL: z.url(),
  GITHUB_WEBHOOK_SECRET: z.string().min(32).max(1_024),
  WALKZ_OAUTH_STATE_SECRET: z.string().min(32).max(1_024),
  WALKZ_PROMPT_VERSION: z.string().trim().min(1).max(128).default('hosted-v1'),
  WALKZ_HOST: z.string().trim().min(1).max(255).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
}).passthrough();

export interface HostedApiEnvironment {
  databaseUrl: string;
  githubAppId: string;
  githubPrivateKey: string;
  githubClientId: string;
  githubClientSecret: string;
  githubOAuthCallbackUrl: string;
  githubWebhookSecret: string;
  oauthStateSecret: string;
  promptVersion: string;
  host: string;
  port: number;
}

function decodePrivateKey(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  if (
    !decoded.startsWith('-----BEGIN') ||
    !decoded.endsWith('PRIVATE KEY-----') ||
    Buffer.byteLength(decoded, 'utf8') > 65_536
  ) {
    throw new Error('GITHUB_PRIVATE_KEY_BASE64 must contain a PEM private key.');
  }
  return decoded;
}

export function parseHostedApiEnvironment(input: NodeJS.ProcessEnv): HostedApiEnvironment {
  const environment = environmentSchema.parse(input);
  return {
    databaseUrl: environment.DATABASE_URL,
    githubAppId: environment.GITHUB_APP_ID,
    githubPrivateKey: decodePrivateKey(environment.GITHUB_PRIVATE_KEY_BASE64),
    githubClientId: environment.GITHUB_CLIENT_ID,
    githubClientSecret: environment.GITHUB_CLIENT_SECRET,
    githubOAuthCallbackUrl: environment.GITHUB_OAUTH_CALLBACK_URL,
    githubWebhookSecret: environment.GITHUB_WEBHOOK_SECRET,
    oauthStateSecret: environment.WALKZ_OAUTH_STATE_SECRET,
    promptVersion: environment.WALKZ_PROMPT_VERSION,
    host: environment.WALKZ_HOST,
    port: environment.PORT,
  };
}

export function createHostedApiFromEnvironment(input: NodeJS.ProcessEnv) {
  const config = parseHostedApiEnvironment(input);
  const pool = createDatabasePool({
    connectionString: config.databaseUrl,
    maxConnections: 10,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
  });
  const githubApp = createGitHubInstallationApp({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    requestTimeoutMs: 15_000,
  });
  const sessions = createPersistentGitHubSessionService(
    pool,
    createGitHubUserIdentityClient(),
  );
  const authenticator = createApiSessionAuthenticator(sessions);
  const app = createHostedApi({
    githubAuth: {
      stateSigner: createOAuthStateSigner(config.oauthStateSecret),
      oauthClient: createGitHubOAuthClient({
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        callbackUrl: config.githubOAuthCallbackUrl,
      }),
      sessionIssuer: sessions,
      stateStore: {
        store: (state) => storeOAuthState(pool, state),
        consume: (state) => consumeOAuthState(pool, state),
      },
      clientId: config.githubClientId,
      callbackUrl: config.githubOAuthCallbackUrl,
    },
    installations: {
      authenticator,
      repositories: createPersistentInstallationRepositoryStore(
        pool,
        createInstallationRepositoryCatalogFactory(githubApp),
      ),
    },
    manualReviews: {
      authenticator,
      reviews: createPersistentManualReviewStarter(
        pool,
        createInstallationPullRequestReaderFactory(githubApp),
        config.promptVersion,
      ),
    },
    repositories: {
      authenticator,
      configHistory: { list: (repositoryId) => listRepositoryConfigVersions(pool, repositoryId) },
      reviewHistory: { list: (repositoryId) => listReviewHistory(pool, { repositoryId, limit: 100 }) },
    },
    webhook: {
      secret: config.githubWebhookSecret,
      promptVersion: config.promptVersion,
      intake: createPersistentGitHubWebhookIntake(pool),
    },
    readiness: {
      async check() {
        const result = await pool.query('SELECT 1 AS ready');
        return result.rows[0]?.ready === 1;
      },
    },
    logger: true,
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return { app, config };
}
