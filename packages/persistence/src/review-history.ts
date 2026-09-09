import type { Pool } from 'pg';
import { z } from 'zod';

const historyQuerySchema = z
  .object({
    repositoryId: z.uuid(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export interface ReviewHistoryItem {
  id: string;
  pullRequestId: string | null;
  baseSha: string;
  headSha: string;
  status: string;
  verdict: string | null;
  resultSummary: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function listReviewHistory(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<ReviewHistoryItem[]> {
  const query = historyQuerySchema.parse(input);
  const result = await pool.query<ReviewHistoryItem>(
    `
      SELECT id,
             pull_request_id AS "pullRequestId",
             base_sha AS "baseSha",
             head_sha AS "headSha",
             status,
             verdict,
             result_summary AS "resultSummary",
             created_at AS "createdAt",
             completed_at AS "completedAt"
      FROM review_runs
      WHERE repository_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [query.repositoryId, query.limit],
  );
  return result.rows;
}
