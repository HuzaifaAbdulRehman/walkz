import { describe, expect, it, vi } from 'vitest';

import { exportReviewEvaluationSnapshot } from '../src/index.js';

const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const reviewRunId = 'a9a6b8c9-3d24-4753-b888-bd483f32f18a';
const findingId = '299d7b35-f46b-4981-b4f8-000d2f494e41';
const createdAfter = new Date('2026-09-01T00:00:00.000Z');
const createdBefore = new Date('2026-10-01T00:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    reviewRunId,
    configHash: 'a'.repeat(64),
    provider: 'groq',
    model: 'model-a',
    promptVersion: 'review-v3',
    promptTokens: 80,
    completionTokens: 20,
    totalTokens: 100,
    latencyMs: 45,
    findingId,
    evidenceLevel: 'VERIFIED',
    lifecycleStatus: 'fixed',
    proofOutcome: 'verified',
    feedback: 'correct',
    ...overrides,
  };
}

describe('review evaluation export', () => {
  it('exports only bounded metadata for an authorized repository cohort', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });

    await expect(exportReviewEvaluationSnapshot({ query }, {
      actorUserId,
      repositoryId,
      cohortId: 'september-2026',
      createdAfter,
      createdBefore,
      limit: 25,
    }, {
      now: () => new Date('2026-10-02T00:00:00.000Z'),
    })).resolves.toEqual({
      schemaVersion: 1,
      cohortId: 'september-2026',
      createdAt: '2026-10-02T00:00:00.000Z',
      runs: [{
        reviewRunId,
        configHash: 'a'.repeat(64),
        provider: 'groq',
        model: 'model-a',
        promptVersion: 'review-v3',
        usage: {
          promptTokens: 80,
          completionTokens: 20,
          totalTokens: 100,
          latencyMs: 45,
        },
        findings: [{
          findingId,
          evidenceLevel: 'VERIFIED',
          lifecycleStatus: 'fixed',
          proofOutcome: 'verified',
          feedback: 'correct',
        }],
      }],
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(query.mock.calls[0]?.[1]).toEqual([
      actorUserId,
      repositoryId,
      createdAfter,
      createdBefore,
      25,
    ]);
    expect(sql).toContain('ura.user_id = $1');
    expect(sql).toContain('rr.repository_id = $2');
    expect(sql).toContain("rr.status IN ('completed', 'inconclusive')");
    expect(sql).toContain("mi.stage = 'review'");
    expect(sql).toContain("mi.status = 'succeeded'");
    expect(sql).toContain('mi.invocation_count = 1');
    expect(sql).toContain('bounded_finding.review_run_id = rr.id');
    expect(sql).toContain(') <= 50');
    expect(sql).toContain('LIMIT $5');
    expect(sql).not.toContain('prompt_hash');
    expect(sql).not.toContain('response_hash');
    expect(sql).not.toContain('sanitized_summary');
  });

  it('keeps runs with no findings and returns null for an empty cohort', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [row({
          findingId: null,
          evidenceLevel: null,
          lifecycleStatus: null,
          proofOutcome: null,
          feedback: null,
        })],
      })
      .mockResolvedValueOnce({ rows: [] });
    const input = {
      actorUserId,
      repositoryId,
      cohortId: 'empty-findings',
      createdAfter,
      createdBefore,
    };

    await expect(exportReviewEvaluationSnapshot({ query }, input))
      .resolves.toMatchObject({ runs: [{ findings: [] }] });
    await expect(exportReviewEvaluationSnapshot({ query }, input))
      .resolves.toBeNull();
  });

  it('rejects invalid windows and inconsistent database rows', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [row({ totalTokens: 99 })],
    });

    await expect(exportReviewEvaluationSnapshot({ query }, {
      actorUserId,
      repositoryId,
      cohortId: 'invalid-window',
      createdAfter: createdBefore,
      createdBefore: createdAfter,
    })).rejects.toThrow('Evaluation start time must precede its end time.');
    expect(query).not.toHaveBeenCalled();

    await expect(exportReviewEvaluationSnapshot({ query }, {
      actorUserId,
      repositoryId,
      cohortId: 'invalid-row',
      createdAfter,
      createdBefore,
    })).rejects.toThrow('Total tokens must equal prompt plus completion tokens.');
  });

  it('rejects partially bound finding metadata', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [row({ findingId: null })],
    });

    await expect(exportReviewEvaluationSnapshot({ query }, {
      actorUserId,
      repositoryId,
      cohortId: 'bad-binding',
      createdAfter,
      createdBefore,
    })).rejects.toThrow(
      'Evaluation finding metadata must be present as one bound record.',
    );
  });
});
