import { describe, expect, it, vi } from 'vitest';

import {
  claimPatchFixJob,
  completePatchFixJob,
  createPatchFixProposal,
  createPatchFixProposalForCommentCommand,
  decidePatchFixProposal,
  failPatchFixJob,
  listRecoverablePatchFixProposalIds,
  releasePatchFixJob,
} from '../src/index.js';

const repositoryId = '8aa2dfc8-c97f-454f-b838-cc0cda4a7460';
const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const reviewRunId = 'f931b8c5-f267-4b1b-8cb4-273695d4448e';
const findingId = '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const patchHash = 'c'.repeat(64);
const proofPlanDigest = 'd'.repeat(64);
const proofCommandDigest = 'e'.repeat(64);
const createdAt = new Date('2026-09-11T12:00:00.000Z');

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: proposalId,
    reviewRunId,
    findingId,
    baseSha,
    headSha,
    patchHash,
    deliveryMode: 'suggestion',
    approvalStatus: 'pending',
    githubReferenceKind: null,
    githubReferenceValue: null,
    decidedByUserId: null,
    decidedAt: null,
    staleAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    proposalId,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    promptVersion: 'walkz-patch-v1',
    proofPlanDigest,
    proofCommandDigest,
    status: 'awaiting_approval',
    attempt: 0,
    failureCode: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

function transactionalPool(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('hosted patch fix persistence', () => {
  it('creates proposal and regeneration metadata in one transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposalRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-id' }] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await createPatchFixProposal(transactionalPool(query), {
      proposal: {
        reviewRunId,
        findingId,
        baseSha,
        headSha,
        patchHash,
        deliveryMode: 'suggestion',
      },
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      promptVersion: 'walkz-patch-v1',
      proofPlanDigest,
      proofCommandDigest,
    });

    expect(result).toMatchObject({ created: true, proposal: { id: proposalId } });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO patch_proposals'),
      expect.stringContaining('INSERT INTO audit_events'),
      expect.stringContaining('INSERT INTO patch_fix_jobs'),
      'COMMIT',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('replacement');
  });

  it('atomically binds a generated proposal to its leased comment command', async () => {
    const commandId = '9058b3c9-3243-43b3-b0d8-dd692ece130f';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposalRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-id' }] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [{ id: commandId }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(createPatchFixProposalForCommentCommand(transactionalPool(query), {
      commandId,
      workerId: 'worker-1',
      proposal: {
        reviewRunId,
        findingId,
        baseSha,
        headSha,
        patchHash,
        deliveryMode: 'suggestion',
      },
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      promptVersion: 'walkz-patch-v1',
      proofPlanDigest,
      proofCommandDigest,
    })).resolves.toMatchObject({ proposal: { id: proposalId }, created: true });

    const linkSql = String(query.mock.calls[4]?.[0]);
    expect(linkSql).toContain('patch_proposal_id = $3');
    expect(linkSql).toContain('lease_owner = $2');
    expect(query.mock.calls[4]?.[1]).toEqual([commandId, 'worker-1', proposalId]);
  });

  it('rolls back proposal creation when the command lease is lost', async () => {
    const commandId = '9058b3c9-3243-43b3-b0d8-dd692ece130f';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposalRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-id' }] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(createPatchFixProposalForCommentCommand(transactionalPool(query), {
      commandId,
      workerId: 'stale-worker',
      proposal: {
        reviewRunId,
        findingId,
        baseSha,
        headSha,
        patchHash,
        deliveryMode: 'suggestion',
      },
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      promptVersion: 'walkz-patch-v1',
      proofPlanDigest,
      proofCommandDigest,
    })).rejects.toThrow('lost its lease');

    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('queues one identifier-only job after approval', async () => {
    const approvedAt = new Date('2026-09-11T12:01:00.000Z');
    const approved = proposalRow({
      approvalStatus: 'approved',
      decidedByUserId: actorUserId,
      decidedAt: approvedAt,
      updatedAt: approvedAt,
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        ...proposalRow(),
        currentHeadSha: headSha,
        runStatus: 'awaiting_human',
        findingLifecycleStatus: 'verified',
        evidenceLevel: 'VERIFIED',
      }] })
      .mockResolvedValueOnce({ rows: [approved] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-id' }] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [jobRow({ status: 'queued', updatedAt: approvedAt })] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-id' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await decidePatchFixProposal(transactionalPool(query), {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      job: { status: 'queued' },
      outboxEventId: 'outbox-id',
    });
    const outboxCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO outbox_events'));
    expect(JSON.parse(outboxCall?.[1]?.[2] as string)).toEqual({ proposalId });
  });

  it('finishes rejected jobs without creating an outbox event', async () => {
    const rejectedAt = new Date('2026-09-11T12:01:00.000Z');
    const rejected = proposalRow({
      approvalStatus: 'rejected',
      decidedByUserId: actorUserId,
      decidedAt: rejectedAt,
      updatedAt: rejectedAt,
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        ...proposalRow(),
        currentHeadSha: headSha,
        runStatus: 'awaiting_human',
        findingLifecycleStatus: 'verified',
        evidenceLevel: 'VERIFIED',
      }] })
      .mockResolvedValueOnce({ rows: [rejected] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-id' }] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [jobRow({
        status: 'rejected',
        updatedAt: rejectedAt,
        completedAt: rejectedAt,
      })] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await decidePatchFixProposal(transactionalPool(query), {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'rejected',
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      job: { status: 'rejected' },
      outboxEventId: null,
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO outbox_events'))).toBe(false);
  });

  it('claims only an approved current proposal for reproof', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [jobRow({ status: 'reproving', attempt: 1 })],
    });

    await expect(claimPatchFixJob({ query }, {
      proposalId,
      workerId: 'worker-1',
      leaseMs: 60_000,
    })).resolves.toMatchObject({ status: 'reproving', attempt: 1 });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("pp.approval_status = 'approved'");
    expect(sql).toContain('pp.head_sha = pr.head_sha');
    expect(sql).toContain("f.evidence_level = 'VERIFIED'");
    expect(sql).not.toContain('pp.github_reference IS NULL');
  });

  it('requires matching reproof evidence before completion', async () => {
    const completedAt = new Date('2026-09-11T12:02:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [jobRow({
        status: 'resolved',
        attempt: 1,
        updatedAt: completedAt,
        completedAt,
      })],
    });

    await expect(completePatchFixJob({ query }, {
      proposalId,
      workerId: 'worker-1',
      outcome: 'resolved',
    })).resolves.toMatchObject({ status: 'resolved' });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("e.evidence_kind = 'patch_reproof'");
    expect(sql).not.toContain('e.reproof_attempt = pfj.attempt');
    expect(sql).toContain("pp.github_reference IS NOT NULL");
  });

  it('releases retryable work and records final failures explicitly', async () => {
    const releaseQuery = vi.fn().mockResolvedValue({ rows: [{ proposalId }] });
    await expect(releasePatchFixJob({ query: releaseQuery }, {
      proposalId,
      workerId: 'worker-1',
    })).resolves.toBe(true);
    expect(String(releaseQuery.mock.calls[0]?.[0])).toContain("status = 'queued'");

    const failedAt = new Date('2026-09-11T12:03:00.000Z');
    const failQuery = vi.fn().mockResolvedValue({
      rows: [jobRow({
        status: 'failed',
        attempt: 5,
        failureCode: 'proof_infrastructure_failed',
        updatedAt: failedAt,
        completedAt: failedAt,
      })],
    });
    await expect(failPatchFixJob({ query: failQuery }, {
      proposalId,
      workerId: 'worker-1',
      failureCode: 'proof_infrastructure_failed',
    })).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'proof_infrastructure_failed',
    });
  });

  it('lists only queued or expired reproof jobs below the retry cap', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ proposalId }] });
    await expect(listRecoverablePatchFixProposalIds({ query }, 50))
      .resolves.toEqual([proposalId]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('attempt < 5');
    expect(sql).toContain('lease_expires_at <= now()');
  });
});
