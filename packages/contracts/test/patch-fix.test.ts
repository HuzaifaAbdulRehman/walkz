import { describe, expect, it } from 'vitest';

import { parsePatchFixJob } from '../src/index.js';

const createdAt = new Date('2026-09-11T12:00:00.000Z');

function job(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: '34e04c9f-bf3a-4ab9-9c81-902ad75d0110',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    promptVersion: 'walkz-patch-v1',
    proofPlanDigest: 'a'.repeat(64),
    proofCommandDigest: 'b'.repeat(64),
    status: 'awaiting_approval',
    attempt: 0,
    failureCode: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

describe('patch fix job contract', () => {
  it('accepts active and terminal jobs with matching metadata', () => {
    expect(parsePatchFixJob(job())).toMatchObject({
      status: 'awaiting_approval',
      attempt: 0,
    });
    expect(parsePatchFixJob(job({
      status: 'resolved',
      attempt: 1,
      completedAt: new Date('2026-09-11T12:01:00.000Z'),
      updatedAt: new Date('2026-09-11T12:01:00.000Z'),
    }))).toMatchObject({ status: 'resolved', attempt: 1 });
  });

  it('requires failure codes only for failed jobs', () => {
    expect(() => parsePatchFixJob(job({
      status: 'failed',
      completedAt: new Date('2026-09-11T12:01:00.000Z'),
      updatedAt: new Date('2026-09-11T12:01:00.000Z'),
    }))).toThrow();
    expect(() => parsePatchFixJob(job({
      failureCode: 'workflow_failed',
    }))).toThrow();
  });

  it('rejects completed active jobs and incomplete terminal jobs', () => {
    expect(() => parsePatchFixJob(job({ completedAt: createdAt }))).toThrow();
    expect(() => parsePatchFixJob(job({ status: 'inconclusive' }))).toThrow();
  });
});
