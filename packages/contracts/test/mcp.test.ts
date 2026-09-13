import { describe, expect, it } from 'vitest';

import {
  walkzMcpFixInputSchema,
  walkzMcpGrantSchema,
} from '../src/index.js';

const grant = {
  grantId: '11111111-1111-4111-8111-111111111111',
  audience: 'walkz-mcp',
  subjectId: '22222222-2222-4222-8222-222222222222',
  repositoryId: '33333333-3333-4333-8333-333333333333',
  capabilities: ['read', 'prove', 'fix'],
  callLimits: { read: 20, prove: 5, fix: 2 },
  issuedAt: '2026-09-13T12:00:00.000Z',
  expiresAt: '2026-09-13T12:15:00.000Z',
};

describe('Walkz MCP contracts', () => {
  it('accepts a unique short-lived capability grant', () => {
    expect(walkzMcpGrantSchema.parse(grant)).toEqual(grant);
  });

  it('rejects duplicate, overlong, and wrong-audience grants', () => {
    expect(() => walkzMcpGrantSchema.parse({
      ...grant,
      capabilities: ['read', 'read'],
    })).toThrow(/unique/i);
    expect(() => walkzMcpGrantSchema.parse({
      ...grant,
      expiresAt: '2026-09-13T12:15:00.001Z',
    })).toThrow(/15 minutes/i);
    expect(() => walkzMcpGrantSchema.parse({
      ...grant,
      audience: 'another-service',
    })).toThrow();
  });

  it('requires call limits to match the granted capabilities', () => {
    expect(() => walkzMcpGrantSchema.parse({
      ...grant,
      capabilities: ['read'],
    })).toThrow(/call limits/i);
    expect(() => walkzMcpGrantSchema.parse({
      ...grant,
      callLimits: { read: 20, prove: 5, fix: 0 },
    })).toThrow(/call limits/i);
  });

  it('does not accept identity, repository, approval, or patch text as fix input', () => {
    expect(() => walkzMcpFixInputSchema.parse({
      requestId: '44444444-4444-4444-8444-444444444444',
      reviewRunId: '55555555-5555-4555-8555-555555555555',
      findingId: '66666666-6666-4666-8666-666666666666',
      expectedHeadSha: 'a'.repeat(40),
      repositoryId: grant.repositoryId,
      subjectId: grant.subjectId,
      approved: true,
      patch: 'untrusted patch text',
    })).toThrow();
  });
});
