import { describe, expect, it } from 'vitest';

import {
  parseDashboardPatchFixes,
  parsePatchProposalResponse,
} from './patch-fixes.js';

const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
const headSha = 'a'.repeat(40);
const patchHash = 'b'.repeat(64);
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
        findingId,
        headSha,
        patchHash,
        path: 'src/value.ts',
        startLine: 3,
        endLine: 3,
        replacement: 'return safe;',
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
});
