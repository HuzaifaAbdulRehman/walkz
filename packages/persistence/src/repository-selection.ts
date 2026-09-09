import { createHash } from 'node:crypto';

import { parseWalkzConfig } from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

import { saveRepositoryConfig } from './repository-config.js';
import { withTransaction } from './outbox.js';

const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  { message: 'GitHub IDs must fit PostgreSQL BIGINT.' },
);
const accessInputSchema = z.object({
  userId: z.uuid(),
  installationId: githubIdSchema,
}).strict();
const selectionInputSchema = accessInputSchema.extend({
  repository: z.object({
    githubId: githubIdSchema,
    owner: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
  }).strict(),
  config: z.unknown(),
}).strict();
const grantSchema = z.object({
  githubId: githubIdSchema,
  selectedRepositoryId: z.uuid().nullable(),
}).strict();
const installationSchema = z.object({ installationId: z.uuid() }).strict();
const repositorySchema = z.object({ repositoryId: z.uuid() }).strict();

export interface GrantedRepository {
  githubId: string;
  selectedRepositoryId: string | null;
}

export async function listGrantedRepositories(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<GrantedRepository[]> {
  const access = accessInputSchema.parse(input);
  const result = await pool.query(
    `SELECT ura.github_repository_id::text AS "githubId",
            r.id AS "selectedRepositoryId"
     FROM github_installations gi
     JOIN user_installations ui ON ui.installation_id = gi.id
     JOIN user_repository_access ura
       ON ura.user_id = ui.user_id AND ura.installation_id = gi.id
     LEFT JOIN repositories r
       ON r.installation_id = gi.id AND r.github_id = ura.github_repository_id
     WHERE ui.user_id = $1 AND gi.github_id = $2::bigint
     ORDER BY ura.github_repository_id ASC`,
    [access.userId, access.installationId],
  );
  return z.array(grantSchema).parse(result.rows);
}

export async function selectGrantedRepository(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<{ repositoryId: string; configCreated: boolean }> {
  const selection = selectionInputSchema.parse(input);
  const config = parseWalkzConfig(selection.config);
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return withTransaction(pool, async (client) => {
    const access = await client.query(
      `SELECT gi.id AS "installationId"
       FROM github_installations gi
       JOIN user_installations ui ON ui.installation_id = gi.id
       JOIN user_repository_access ura
         ON ura.user_id = ui.user_id AND ura.installation_id = gi.id
       WHERE ui.user_id = $1
         AND gi.github_id = $2::bigint
         AND ura.github_repository_id = $3::bigint
       FOR UPDATE OF gi`,
      [selection.userId, selection.installationId, selection.repository.githubId],
    );
    const installation = installationSchema.safeParse(access.rows[0]);
    if (!installation.success) {
      throw new Error('Repository access was not found.');
    }
    const stored = await client.query(
      `INSERT INTO repositories
        (installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2::bigint, $3, $4)
       ON CONFLICT (installation_id, github_id) DO UPDATE
       SET owner_login = EXCLUDED.owner_login,
           repository_name = EXCLUDED.repository_name
       RETURNING id AS "repositoryId"`,
      [
        installation.data.installationId,
        selection.repository.githubId,
        selection.repository.owner,
        selection.repository.name,
      ],
    );
    const repository = repositorySchema.parse(stored.rows[0]);
    const configResult = await saveRepositoryConfig(client, {
      repositoryId: repository.repositoryId,
      schemaVersion: config.schemaVersion,
      configHash,
      config,
    });
    return {
      repositoryId: repository.repositoryId,
      configCreated: configResult === 'created',
    };
  });
}
