import { Pool } from 'pg';
import { z } from 'zod';

export const databasePoolConfigSchema = z
  .object({
    connectionString: z.url().refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'postgres:' || protocol === 'postgresql:';
      },
      { message: 'Database URLs must use the PostgreSQL protocol.' },
    ),
    maxConnections: z.number().int().min(1).max(50),
    connectionTimeoutMs: z.number().int().min(100).max(60_000),
    idleTimeoutMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

export type DatabasePoolConfig = z.infer<typeof databasePoolConfigSchema>;

export function parseDatabasePoolConfig(input: unknown): DatabasePoolConfig {
  return databasePoolConfigSchema.parse(input);
}

export function createDatabasePool(input: unknown): Pool {
  const config = parseDatabasePoolConfig(input);
  return new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    max: config.maxConnections,
  });
}
