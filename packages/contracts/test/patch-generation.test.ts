import { describe, expect, it } from 'vitest';

import {
  parseModelPatchResponse,
  parsePatchCandidate,
} from '../src/index.js';

const patch = {
  findingId: '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68',
  headSha: 'b'.repeat(40),
  path: 'src/value.ts',
  startLine: 4,
  endLine: 5,
  replacement: 'return value ?? fallback;',
  approvalRequired: true,
} as const;

describe('patch generation contracts', () => {
  it('accepts one bounded approval-gated replacement', () => {
    expect(parseModelPatchResponse(patch)).toEqual(patch);
  });

  it.each([
    '../secret.ts',
    '/etc/passwd',
    'C:/secret.ts',
    'src\\secret.ts',
    '.git/config',
    'src//value.ts',
    ' src/value.ts',
  ])('rejects unsafe patch path %s', (path) => {
    expect(() => parseModelPatchResponse({ ...patch, path })).toThrow();
  });

  it('rejects oversized and non-approved model output', () => {
    expect(() => parseModelPatchResponse({
      ...patch,
      endLine: patch.startLine + 100,
    })).toThrow('at most 100');
    expect(() => parseModelPatchResponse({
      ...patch,
      approvalRequired: false,
    })).toThrow();
  });

  it('requires candidate hashes and different revisions', () => {
    expect(() => parsePatchCandidate({
      ...patch,
      schemaVersion: 1,
      reviewRunId: 'f931b8c5-f267-4b1b-8cb4-273695d4448e',
      baseSha: patch.headSha,
      deliveryMode: 'suggestion',
      originalHash: 'c'.repeat(64),
      patchHash: 'd'.repeat(64),
    })).toThrow('changed head revision');
  });
});
