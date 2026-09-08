import type { Pool } from 'pg';
import { z } from 'zod';

const repositoryConfigInputSchema = z
  .object({
    repositoryId: z.uuid(),
    schemaVersion: z.number().int().positive(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/i),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface RepositoryConfigVersion {
  id: string;
  repositoryId: string;
  schemaVersion: number;
  configHash: string;
  config: Record<string, unknown>;
  createdAt: Date;
}

export async function saveRepositoryConfig(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<'created' | 'existing'> {
  const config = repositoryConfigInputSchema.parse(input);
  const result = await pool.query(
    `
      INSERT INTO repository_configs
        (repository_id, schema_version, config_hash, config)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (repository_id, config_hash) DO NOTHING
      RETURNING id
    `,
    [
      config.repositoryId,
      config.schemaVersion,
      config.configHash,
      JSON.stringify(config.config),
    ],
  );
  return result.rows.length === 1 ? 'created' : 'existing';
}

export async function listRepositoryConfigVersions(
  pool: Pick<Pool, 'query'>,
  repositoryIdInput: unknown,
): Promise<RepositoryConfigVersion[]> {
  const repositoryId = z.uuid().parse(repositoryIdInput);
  const result = await pool.query<RepositoryConfigVersion>(
    `
      SELECT id,
             repository_id AS "repositoryId",
             schema_version AS "schemaVersion",
             config_hash AS "configHash",
             config,
             created_at AS "createdAt"
      FROM repository_configs
      WHERE repository_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [repositoryId],
  );
  return result.rows;
}
