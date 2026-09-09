import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { z } from 'zod';

import { withTransaction } from './outbox.js';

const githubIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: 'GitHub IDs must fit PostgreSQL BIGINT.',
  });
const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const oauthStateSchema = z.object({
  stateId: z.uuid(),
  expiresAt: z.date(),
}).strict();
const identitySchema = z.object({
  githubId: githubIdSchema,
  login: z.string().trim().min(1).max(100),
  installations: z.array(z.object({
    installationId: githubIdSchema,
    accountLogin: z.string().trim().min(1).max(100),
    repositories: z.array(z.object({
      githubId: githubIdSchema,
      owner: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(100),
    }).strict()).max(1_000),
  }).strict()).max(1_000),
}).strict().refine(
  (identity) => new Set(identity.installations.map((item) => item.installationId)).size === identity.installations.length,
  { message: 'GitHub installations must be unique.', path: ['installations'] },
);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface GitHubIdentityResolver {
  load(accessToken: string): Promise<unknown>;
}

export interface SessionPrincipal {
  userId: string;
  installationIds: string[];
  repositoryIds: string[];
}

export interface PersistentGitHubSessionService {
  create(accessToken: string): Promise<{ sessionId: string; expiresAt: Date }>;
  authenticate(sessionId: string): Promise<SessionPrincipal | null>;
  revoke(sessionId: string): Promise<boolean>;
}

export async function storeOAuthState(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<void> {
  const state = oauthStateSchema.parse(input);
  await pool.query(
    'INSERT INTO oauth_states (id, expires_at) VALUES ($1, $2)',
    [state.stateId, state.expiresAt],
  );
}

export async function consumeOAuthState(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<boolean> {
  const state = z.object({ stateId: z.uuid(), now: z.date() }).strict().parse(input);
  const result = await pool.query(
    `UPDATE oauth_states
     SET consumed_at = $2
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
     RETURNING id`,
    [state.stateId, state.now],
  );
  return result.rows.length === 1;
}

export async function purgeExpiredOAuthStates(
  pool: Pick<Pool, 'query'>,
  beforeInput: unknown,
): Promise<number> {
  const before = z.coerce.date().parse(beforeInput);
  const result = await pool.query('DELETE FROM oauth_states WHERE expires_at <= $1', [before]);
  return result.rowCount ?? 0;
}

export async function purgeExpiredSessions(
  pool: Pick<Pool, 'query'>,
  beforeInput: unknown,
): Promise<number> {
  const before = z.coerce.date().parse(beforeInput);
  const result = await pool.query(
    'DELETE FROM sessions WHERE expires_at <= $1 OR revoked_at <= $1',
    [before],
  );
  return result.rowCount ?? 0;
}

export function createPersistentGitHubSessionService(
  pool: Pick<Pool, 'connect' | 'query'>,
  identityResolver: GitHubIdentityResolver,
  options: { ttlMs?: number; now?: () => Date } = {},
): PersistentGitHubSessionService {
  const ttlMs = z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1_000)
    .parse(options.ttlMs ?? 7 * 24 * 60 * 60 * 1_000);
  const now = options.now ?? (() => new Date());
  return {
    async create(accessToken) {
      const token = z.string().trim().min(1).max(1_024).parse(accessToken);
      const identity = identitySchema.parse(await identityResolver.load(token));
      const sessionId = randomBytes(32).toString('base64url');
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + ttlMs);
      await withTransaction(pool, async (client) => {
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users (github_id, login)
           VALUES ($1, $2)
           ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login
           RETURNING id`,
          [identity.githubId, identity.login],
        );
        const userId = userResult.rows[0]?.id;
        if (userId === undefined) throw new Error('User storage did not return an ID.');

        for (const installation of identity.installations) {
          const installationResult = await client.query<{ id: string }>(
            `INSERT INTO github_installations (github_id, account_login)
             VALUES ($1, $2)
             ON CONFLICT (github_id) DO UPDATE SET account_login = EXCLUDED.account_login
             RETURNING id`,
            [installation.installationId, installation.accountLogin],
          );
          const installationId = installationResult.rows[0]?.id;
          if (installationId === undefined) throw new Error('Installation storage did not return an ID.');
          await client.query(
            `INSERT INTO user_installations (user_id, installation_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, installation_id) DO NOTHING`,
            [userId, installationId],
          );
          for (const repository of installation.repositories) {
            await client.query(
              `INSERT INTO user_repository_access
                (user_id, installation_id, github_repository_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, installation_id, github_repository_id) DO NOTHING`,
              [userId, installationId, repository.githubId],
            );
          }
          await client.query(
            `DELETE FROM user_repository_access
             WHERE user_id = $1 AND installation_id = $2
               AND NOT (github_repository_id = ANY($3::bigint[]))`,
            [
              userId,
              installationId,
              installation.repositories.map((repository) => repository.githubId),
            ],
          );
        }

        await client.query(
          `DELETE FROM user_installations ui
           USING github_installations gi
           WHERE ui.installation_id = gi.id
             AND ui.user_id = $1
             AND NOT (gi.github_id = ANY($2::bigint[]))`,
          [userId, identity.installations.map((installation) => installation.installationId)],
        );
        await client.query(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [userId, hashToken(sessionId), expiresAt],
        );
      });
      return { sessionId, expiresAt };
    },

    async authenticate(sessionIdInput) {
      const sessionId = sessionTokenSchema.parse(sessionIdInput);
      const result = await pool.query<SessionPrincipal>(
        `SELECT s.user_id AS "userId",
                COALESCE(
                  array_agg(DISTINCT gi.github_id::text) FILTER (WHERE gi.id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS "installationIds",
                COALESCE(
                  array_agg(DISTINCT r.id::text) FILTER (WHERE r.id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS "repositoryIds"
         FROM sessions s
         LEFT JOIN user_installations ui ON ui.user_id = s.user_id
         LEFT JOIN github_installations gi ON gi.id = ui.installation_id
         LEFT JOIN user_repository_access ura
           ON ura.user_id = s.user_id AND ura.installation_id = gi.id
         LEFT JOIN repositories r
           ON r.installation_id = ura.installation_id
          AND r.github_id = ura.github_repository_id
         WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL
         GROUP BY s.user_id`,
        [hashToken(sessionId), now()],
      );
      return result.rows[0] ?? null;
    },

    async revoke(sessionIdInput) {
      const sessionId = sessionTokenSchema.parse(sessionIdInput);
      const result = await pool.query(
        `UPDATE sessions SET revoked_at = $2
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(sessionId), now()],
      );
      return (result.rowCount ?? 0) === 1;
    },
  };
}
