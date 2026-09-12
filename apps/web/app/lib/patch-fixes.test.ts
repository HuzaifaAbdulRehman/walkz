import { describe, expect, it } from 'vitest';

import {
  parseDashboardPatchFixes,
  parsePatchProposalResponse,
} from './patch-fixes.js';

const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const baseSha = 'c'.repeat(40);
const headSha = 'a'.repeat(40);
const patchHash = 'b'.repeat(64);
const originalHash = 'd'.repeat(64);
const timestamp = '2026-09-11T10:00:00.000Z';

describe('patch fix dashboard boundary', () => {
  it('accepts hash-only durable status', () => {
    expect(parseDashboardPatchFixes({ fixes: [{
      proposalId,
      findingId,
      headSha,
      patchHash,
      approvalStatus: 'approved',
      githubReference: null,
      status: 'reproving',
      attempt: 1,
      failureCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    }] })).toHaveLength(1);
  });

  it('keeps replacement text only in the transient proposal result', () => {
    const result = parsePatchProposalResponse({
      candidate: {
        schemaVersion: 1,
        reviewRunId,
        findingId,
        baseSha,
        headSha,
        deliveryMode: 'suggestion',
        patchHash,
        originalHash,
        path: 'src/value.ts',
        startLine: 3,
        endLine: 3,
        replacement: 'return safe;',
        approvalRequired: true,
      },
      proposal: {
        id: proposalId,
        approvalStatus: 'pending',
        githubReference: null,
      },
      job: {
        status: 'awaiting_approval',
        attempt: 0,
        failureCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      },
    });

    expect(result.candidate.replacement).toBe('return safe;');
    expect(result.fix).not.toHaveProperty('replacement');
  });

  it('restores an approved failed proposal from the same regenerated candidate', () => {
    const result = parsePatchProposalResponse({
      candidate: {
        schemaVersion: 1,
        reviewRunId,
        findingId,
        baseSha,
        headSha,
        deliveryMode: 'suggestion',
        patchHash,
        originalHash,
        path: 'src/value.ts',
        startLine: 3,
        endLine: 3,
        replacement: 'return safe;',
        approvalRequired: true,
      },
      proposal: {
        id: proposalId,
        approvalStatus: 'approved',
        githubReference: null,
      },
      job: {
        status: 'failed',
        attempt: 1,
        failureCode: 'candidate_changed',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      },
    });

    expect(result.fix).toMatchObject({
      approvalStatus: 'approved',
      status: 'failed',
      failureCode: 'candidate_changed',
    });
    expect(result.candidate.patchHash).toBe(patchHash);
  });
});
