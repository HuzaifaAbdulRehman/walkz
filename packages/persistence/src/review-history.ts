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
  pullRequestNumber: number | null;
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
      SELECT rr.id,
             pr.number AS "pullRequestNumber",
             rr.base_sha AS "baseSha",
             rr.head_sha AS "headSha",
             rr.status,
             rr.verdict,
             rr.result_summary AS "resultSummary",
             rr.created_at AS "createdAt",
             rr.completed_at AS "completedAt"
      FROM review_runs rr
      LEFT JOIN pull_requests pr ON pr.id = rr.pull_request_id
      WHERE rr.repository_id = $1
      ORDER BY rr.created_at DESC, rr.id DESC
      LIMIT $2
    `,
    [query.repositoryId, query.limit],
  );
  return result.rows;
}
