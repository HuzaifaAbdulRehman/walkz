import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { recordPatchReproofResult } from '../src/index.js';

const proposalId = '20aa81b0-ea7e-4ca0-aac7-b6b1ef08e953';
const reviewRunId = 'd52e8a55-04d3-4f5e-bb82-dd33cfe4ff99';
const findingId = 'b3774453-4268-4c37-93d8-a26b95aee9fc';

const result = {
  schemaVersion: 1,
  proposalId,
  reviewRunId,
  findingId,
  attempt: 1,
  patchHash: 'a'.repeat(64),
  headSha: 'b'.repeat(40),
  outcome: 'resolved',
  proof: {
    kind: 'proof',
    planDigest: 'c'.repeat(64),
    commandDigest: 'd'.repeat(64),
    outcome: 'passed',
    exitCode: 0,
    durationMs: 12,
    sanitizedSummary: 'proof passed',
    artifacts: [{
      kind: 'file',
      sha256: 'e'.repeat(64),
      sizeBytes: 12,
    }],
  },
  regressions: [{
    kind: 'regression',
    planDigest: 'f'.repeat(64),
    commandDigest: '1'.repeat(64),
    outcome: 'passed',
    exitCode: 0,
    durationMs: 8,
    sanitizedSummary: 'regression passed',
    artifacts: [],
  }],
  recordedAt: '2026-09-11T12:00:00.000Z',
} as const;

describe('patch reproof persistence', () => {
  it('stores a hash-only result behind approval and revision gates', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: proposalId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: proposalId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(recordPatchReproofResult(pool, result)).resolves.toEqual({
      outcome: 'applied',
      result,
    });

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT id FROM patch_proposals'),
      expect.stringContaining("evidence_kind = 'patch_reproof'"),
      expect.stringContaining("pp.approval_status = 'approved'"),
      expect.stringContaining('INSERT INTO evidence'),
      expect.stringContaining('INSERT INTO audit_events'),
      'COMMIT',
    ]);
    expect(query.mock.calls[3]?.[0]).toContain('pr.head_sha = pp.head_sha');
    expect(query.mock.calls[3]?.[0]).toContain("f.evidence_level = 'VERIFIED'");
    expect(query.mock.calls[4]?.[1]).toEqual([
      findingId,
      result.proof.planDigest,
      result.proof.commandDigest,
      result.proof.outcome,
      0,
      20,
      'Approved patch reproof was resolved; 1 regression check.',
      JSON.stringify([result.proof.artifacts[0].sha256]),
      reviewRunId,
      proposalId,
      result.patchHash,
      result.headSha,
      1,
      'resolved',
      JSON.stringify(result),
    ]);
    const stored = JSON.parse(query.mock.calls[4]?.[1]?.[14] as string);
    expect(stored).not.toHaveProperty('replacement');
    expect(stored).not.toHaveProperty('patchText');
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns unchanged for an identical retry', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: proposalId }] })
      .mockResolvedValueOnce({ rows: [{ result: structuredClone(result) }] })
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(recordPatchReproofResult(pool, result)).resolves.toEqual({
      outcome: 'unchanged',
      result,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT id FROM patch_proposals'),
      expect.stringContaining("evidence_kind = 'patch_reproof'"),
      expect.stringContaining('INSERT INTO audit_events'),
      'COMMIT',
    ]);
  });

  it('rejects a result that no longer matches an eligible proposal', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: proposalId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(recordPatchReproofResult(pool, result)).resolves.toEqual({
      outcome: 'conflict',
      result: null,
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO evidence'))).toBe(false);
  });

  it('rejects raw patch content before opening a transaction', async () => {
    const connect = vi.fn();

    await expect(recordPatchReproofResult({ connect }, {
      ...result,
      replacement: 'secret source',
    })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
