import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  createPatchProposal,
  decidePatchProposal,
} from '../src/index.js';

const repositoryId = '8aa2dfc8-c97f-454f-b838-cc0cda4a7460';
const actorUserId = '185e34e7-75ad-4903-b31c-ec068f12ada0';
const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const reviewRunId = 'f931b8c5-f267-4b1b-8cb4-273695d4448e';
const findingId = '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const patchHash = 'c'.repeat(64);
const createdAt = new Date('2026-09-11T00:00:00.000Z');

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

function createPool(
  query: ReturnType<typeof vi.fn>,
): {
  pool: Pick<Pool, 'connect'>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pick<Pool, 'connect'>,
    release,
  };
}

describe('patch proposal persistence', () => {
  it('stores only a hash for a verified finding and audits creation', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO patch_proposals')) {
        return { rows: [proposalRow()] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool, release } = createPool(query);

    const result = await createPatchProposal(pool, {
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash,
      deliveryMode: 'suggestion',
    });

    expect(result.created).toBe(true);
    expect(result.proposal.patchHash).toBe(patchHash);
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO patch_proposals'));
    expect(String(insert?.[0])).toContain("rr.status = 'awaiting_human'");
    expect(String(insert?.[0])).toContain("f.evidence_level = 'VERIFIED'");
    expect(String(insert?.[0])).toContain('pr.head_sha = $4');
    expect(String(insert?.[0])).toContain('FOR UPDATE OF rr, pr, f');
    expect(String(insert?.[0])).not.toContain('patch_text');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.created']),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects patch content before opening a transaction', async () => {
    const { pool } = createPool(vi.fn());

    await expect(createPatchProposal(pool, {
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash,
      deliveryMode: 'suggestion',
      patchText: 'private source',
    })).rejects.toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('returns an existing proposal when creation is retried', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO patch_proposals')) return { rows: [] };
      if (sql.includes('FROM patch_proposals pp')) {
        return { rows: [proposalRow()] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    await expect(createPatchProposal(pool, {
      reviewRunId,
      findingId,
      baseSha,
      headSha,
      patchHash,
      deliveryMode: 'suggestion',
    })).resolves.toMatchObject({ created: false, proposal: { id: proposalId } });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO audit_events'))).toBe(false);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('approves only an authorized exact proposal and audits atomically', async () => {
    const decidedAt = new Date('2026-09-11T00:01:00.000Z');
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE OF pp, pr')) {
        return {
          rows: [proposalRow({
            currentHeadSha: headSha,
            runStatus: 'awaiting_human',
            findingLifecycleStatus: 'verified',
            evidenceLevel: 'VERIFIED',
          })],
        };
      }
      if (sql.includes('SET approval_status')) {
        return {
          rows: [proposalRow({
            approvalStatus: 'approved',
            decidedByUserId: actorUserId,
            decidedAt,
            updatedAt: decidedAt,
          })],
        };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    const result = await decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      proposal: { approvalStatus: 'approved', decidedByUserId: actorUserId },
    });
    const lock = query.mock.calls.find(([sql]) =>
      String(sql).includes('FOR UPDATE OF pp, pr'));
    expect(String(lock?.[0])).toContain('JOIN user_repository_access');
    expect(lock?.[1]).toEqual([proposalId, actorUserId, repositoryId]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET approval_status'),
      [proposalId, 'approved', actorUserId, 'pending', patchHash, headSha],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.approved']),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('marks a proposal stale instead of approving a newer PR head', async () => {
    const staleAt = new Date('2026-09-11T00:02:00.000Z');
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE OF pp, pr')) {
        return {
          rows: [proposalRow({
            currentHeadSha: 'd'.repeat(40),
            runStatus: 'superseded',
            findingLifecycleStatus: 'verified',
            evidenceLevel: 'VERIFIED',
          })],
        };
      }
      if (sql.includes('SET stale_at')) {
        return { rows: [proposalRow({ staleAt, updatedAt: staleAt })] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    const result = await decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    });

    expect(result).toMatchObject({
      outcome: 'stale',
      proposal: { approvalStatus: 'pending', staleAt },
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('SET approval_status'))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.stale']),
    );
  });

  it('returns the same denial for a missing or unauthorized proposal', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    await expect(decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    })).resolves.toEqual({ outcome: 'denied', proposal: null });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('SET approval_status'))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.decision_denied']),
    );
  });

  it('rejects a decision that is not bound to the stored patch hash', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE OF pp, pr')) {
        return {
          rows: [proposalRow({
            currentHeadSha: headSha,
            runStatus: 'awaiting_human',
            findingLifecycleStatus: 'verified',
            evidenceLevel: 'VERIFIED',
          })],
        };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    await expect(decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: 'd'.repeat(64),
      expectedHeadSha: headSha,
      decision: 'approved',
    })).resolves.toMatchObject({ outcome: 'conflict' });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('SET approval_status'))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.decision_conflict']),
    );
  });

  it('audits an idempotent decision without changing it again', async () => {
    const decidedAt = new Date('2026-09-11T00:01:00.000Z');
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE OF pp, pr')) {
        return {
          rows: [proposalRow({
            approvalStatus: 'approved',
            decidedByUserId: actorUserId,
            decidedAt,
            updatedAt: decidedAt,
            currentHeadSha: headSha,
            runStatus: 'awaiting_human',
            findingLifecycleStatus: 'verified',
            evidenceLevel: 'VERIFIED',
          })],
        };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    await expect(decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    })).resolves.toMatchObject({ outcome: 'unchanged' });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('SET approval_status'))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      expect.arrayContaining(['patch_proposal.decision_unchanged']),
    );
  });

  it('rolls back the decision when its audit event cannot be stored', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE OF pp, pr')) {
        return {
          rows: [proposalRow({
            currentHeadSha: headSha,
            runStatus: 'awaiting_human',
            findingLifecycleStatus: 'verified',
            evidenceLevel: 'VERIFIED',
          })],
        };
      }
      if (sql.includes('SET approval_status')) {
        return {
          rows: [proposalRow({
            approvalStatus: 'approved',
            decidedByUserId: actorUserId,
            decidedAt: createdAt,
          })],
        };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        throw new Error('audit unavailable');
      }
      return { rows: [] };
    });
    const { pool } = createPool(query);

    await expect(decidePatchProposal(pool, {
      repositoryId,
      actorUserId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    })).rejects.toThrow('audit unavailable');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
});
