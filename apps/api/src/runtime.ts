import {
  createGitHubInstallationApp,
  createGitHubOAuthClient,
  createGitHubUserIdentityClient,
  createInstallationPullRequestReaderFactory,
  createInstallationRepositoryCatalogFactory,
  createInstallationGitHubSuggestionServiceFactory,
  createOAuthStateSigner,
} from '@walkz/github';
import {
  consumeOAuthState,
  createCredentialVault,
  createPatchFixProposal,
  createDatabasePool,
  createPersistentGitHubSessionService,
  decidePatchFixProposal,
  listPatchFixes,
  listReviewFindings,
  listRepositoryConfigVersions,
  listReviewHistory,
  loadProviderCredential,
  loadVerifiedPatchFixSource,
  preparePatchSuggestionPublication,
  recordFindingFeedback,
  recordModelInvocation,
  recordPatchSuggestionPublication,
  releasePatchSuggestionPublication,
  storeOAuthState,
} from '@walkz/persistence';
import { classifyProviderError, validateProviderAccess } from '@walkz/providers';
import { z } from 'zod';

import { createHostedApi } from './hosted-api.js';
import { createPersistentInstallationRepositoryStore } from './installation-store.js';
import { createPersistentManualReviewStarter } from './manual-review-api.js';
import { createPatchSuggestionPublisher } from './patch-suggestion-api.js';
import { createPersistentProviderCredentialStore } from './provider-credential-api.js';
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
  WALKZ_CREDENTIAL_ACTIVE_KEY_ID: z.string().trim().min(1).max(128),
  WALKZ_CREDENTIAL_KEYS_JSON: z.string().min(1).max(100_000),
  WALKZ_PROMPT_VERSION: z.string().trim().min(1).max(128)
    .default('walkz-review-v1'),
  WALKZ_PROOF_IMAGE: z.string().trim().max(512)
    .regex(/^(?!-)[^\s@]+@sha256:[a-f0-9]{64}$/i)
    .default('node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf'),
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
  credentialVault: ReturnType<typeof createCredentialVault>;
  promptVersion: string;
  proofImage: string;
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

function parseCredentialKeys(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('WALKZ_CREDENTIAL_KEYS_JSON must contain a JSON object.');
  }
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
    credentialVault: createCredentialVault({
      activeKeyId: environment.WALKZ_CREDENTIAL_ACTIVE_KEY_ID,
      keys: parseCredentialKeys(environment.WALKZ_CREDENTIAL_KEYS_JSON),
    }),
    promptVersion: environment.WALKZ_PROMPT_VERSION,
    proofImage: environment.WALKZ_PROOF_IMAGE,
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
  const providerCredentials = createPersistentProviderCredentialStore(
    pool,
    config.credentialVault,
  );
  const githubSuggestions = createInstallationGitHubSuggestionServiceFactory(githubApp);
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
    providerCredentials: {
      authenticator,
      credentials: providerCredentials,
      validator: {
        async validate(apiKey) {
          try {
            const access = await validateProviderAccess({
              apiKey,
              requestedModel: 'auto',
              timeoutMs: 10_000,
              maxResponseBytes: 1_048_576,
            });
            return { valid: true, selectedModel: access.selectedModel };
          } catch (error) {
            const failure = classifyProviderError(error);
            return {
              valid: false,
              reason: failure.code === 'authentication' || failure.code === 'permission'
                ? 'rejected'
                : 'unavailable',
            };
          }
        },
      },
    },
    patchFixes: {
      authenticator,
      store: {
        loadSource: (source) => loadVerifiedPatchFixSource(pool, source),
        loadCredential: (binding) =>
          loadProviderCredential(pool, config.credentialVault, binding),
        recordModelInvocation: async ({ reviewRunId, event }) => {
          await recordModelInvocation(pool, { reviewRunId, ...event });
        },
        create: (proposal) => createPatchFixProposal(pool, proposal),
        decide: (decision) => decidePatchFixProposal(pool, decision),
        list: (query) => listPatchFixes(pool, query),
      },
      github: githubSuggestions,
      proofImage: config.proofImage,
    },
    patchSuggestions: {
      authenticator,
      publisher: createPatchSuggestionPublisher({
        prepare: (publication) => preparePatchSuggestionPublication(pool, publication),
        record: (publication) => recordPatchSuggestionPublication(pool, publication),
        release: (publication) => releasePatchSuggestionPublication(pool, publication),
      }, githubSuggestions),
    },
    repositories: {
      authenticator,
      configHistory: { list: (repositoryId) => listRepositoryConfigVersions(pool, repositoryId) },
      reviewHistory: { list: (repositoryId) => listReviewHistory(pool, { repositoryId, limit: 100 }) },
      reviewFindings: {
        list: (repositoryId, reviewRunId) =>
          listReviewFindings(pool, { repositoryId, reviewRunId }),
        recordFeedback: (feedback) => recordFindingFeedback(pool, feedback),
      },
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
