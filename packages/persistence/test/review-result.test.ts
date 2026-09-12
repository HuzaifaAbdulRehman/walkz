import { describe, expect, it, vi } from 'vitest';

import { completeHostedReviewRun } from '../src/index.js';

const runId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const eventId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const input = {
  reviewRunId: runId,
  workerId: 'worker-1',
  baseSha,
  headSha,
  verdict: 'SHIP',
  summary: 'No blocking evidence was found.',
  findings: [{
    fingerprint: 'c'.repeat(64),
    category: 'correctness',
    path: 'src/index.ts',
    startLine: 4,
    endLine: 4,
    severity: 'high',
    summary: 'The changed branch may return the wrong value.',
    lifecycleStatus: 'unverified',
    evidenceLevel: 'UNVERIFIED',
    advisoryConfidence: 0.7,
    claim: 'The changed branch may return the wrong value.',
    failureMechanism: 'The changed branch returns the wrong value.',
    suggestedProof: 'Run the focused reproducer on both revisions.',
  }],
} as const;

function durableRun(status: string) {
  return {
    id: runId,
    status,
    baseSha,
    headSha,
    installationId: '1234',
    owner: 'owner',
    repository: 'repo',
    workerLeaseOwner: status === 'completed' ? null : 'worker-1',
  };
}

function completedPayload() {
  return {
    reviewRunId: runId,
    installationId: '1234',
    owner: 'owner',
    repository: 'repo',
    baseSha,
    headSha,
    verdict: input.verdict,
    summary: input.summary,
    findings: input.findings.map((finding) => ({
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      summary: finding.summary,
    })),
  };
}

describe('hosted review completion', () => {
  it('stores the outcome and check event in one transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [durableRun('proving')] })
      .mockResolvedValueOnce({ rows: [{ id: runId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: eventId }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(completeHostedReviewRun(pool, input)).resolves.toEqual({
      reviewRunId: runId,
      outboxEventId: eventId,
      created: true,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE OF rr'),
      expect.stringContaining('UPDATE review_runs'),
      expect.stringContaining('INSERT INTO findings'),
      expect.stringContaining('INSERT INTO outbox_events'),
      'COMMIT',
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      runId, 'completed', 'SHIP', input.summary, 'proving', 'worker-1',
    ]);
    expect(query.mock.calls[2]?.[0]).toContain('worker_lease_owner = NULL');
    expect(query.mock.calls[1]?.[0]).toContain('rr.base_sha AS "baseSha"');
    expect(query.mock.calls[1]?.[0]).toContain('rr.head_sha AS "headSha"');
    expect(query.mock.calls[1]?.[0]).toContain('gi.github_id::text AS "installationId"');
    const payload = JSON.parse(query.mock.calls[4]?.[1]?.[2] as string);
    expect(payload).toEqual(completedPayload());
    expect(payload).not.toHaveProperty('credential');
    const stored = JSON.parse(query.mock.calls[3]?.[1]?.[1] as string);
    expect(stored[0]).toMatchObject({
      fingerprint: 'c'.repeat(64),
      evidenceLevel: 'UNVERIFIED',
      path: 'src/index.ts',
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a verified fix run open for human approval', async () => {
    const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
    const verified = {
      ...input,
      verdict: 'FIX' as const,
      summary: 'One verified regression needs attention.',
      findings: [{
        ...input.findings[0],
        lifecycleStatus: 'verified' as const,
        evidenceLevel: 'VERIFIED' as const,
        evidence: [{
          kind: 'counterfactual_proof' as const,
          planDigest: 'd'.repeat(64),
          commandDigest: 'e'.repeat(64),
          baseSha,
          headSha,
          baseOutcome: 'passed' as const,
          headOutcome: 'failed' as const,
          baseExitCode: 0,
          headExitCode: 1,
          durationMs: 20,
          sanitizedSummary: 'Base passed; head failed.',
          artifactHashes: [],
          recordedAt: '2026-09-11T10:00:00.000Z',
        }],
      }],
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [durableRun('proving')] })
      .mockResolvedValueOnce({ rows: [{ id: runId }] })
      .mockResolvedValueOnce({ rows: [{ id: findingId, fingerprint: 'c'.repeat(64) }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: eventId }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(completeHostedReviewRun(pool, verified)).resolves.toMatchObject({
      created: true,
    });
    expect(query.mock.calls[2]?.[1]).toEqual([
      runId, 'awaiting_human', 'FIX', verified.summary, 'proving', 'worker-1',
    ]);
    expect(query.mock.calls[4]?.[0]).toContain('INSERT INTO evidence');
    expect(JSON.parse(query.mock.calls[4]?.[1]?.[0] as string)[0]).toMatchObject({
      findingId,
      planDigest: 'd'.repeat(64),
      baseOutcome: 'passed',
      headOutcome: 'failed',
    });
  });

  it('returns the first event for an identical retry', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [durableRun('completed')] })
      .mockResolvedValueOnce({ rows: [{ id: eventId, payload: completedPayload() }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await expect(completeHostedReviewRun(pool, input)).resolves.toEqual({
      reviewRunId: runId,
      outboxEventId: eventId,
      created: false,
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('rejects a conflicting terminal retry', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [durableRun('completed')] })
      .mockResolvedValueOnce({
        rows: [{
          id: eventId,
          payload: { ...completedPayload(), verdict: 'SHIP', findings: [] },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await expect(completeHostedReviewRun(pool, input)).rejects.toThrow(
      'different terminal result',
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('does not complete a superseded run', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [durableRun('superseded')] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await expect(completeHostedReviewRun(pool, input)).rejects.toThrow(
      'Cannot complete a superseded review run',
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE OF rr'),
      'ROLLBACK',
    ]);
  });

  it('rejects completion after the worker loses its lease', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ ...durableRun('reviewing'), workerLeaseOwner: 'worker-2' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(completeHostedReviewRun(pool, input)).rejects.toThrow(
      'lease is not owned by this worker',
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects unsafe paths before opening a transaction', async () => {
    const connect = vi.fn();
    await expect(completeHostedReviewRun({ connect }, {
      ...input,
      findings: [{ ...input.findings[0], path: '../secret.txt' }],
    })).rejects.toThrow('repository-relative');
    expect(connect).not.toHaveBeenCalled();
  });
});
