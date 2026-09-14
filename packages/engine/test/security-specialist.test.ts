import type {
  DeterministicCheckRun,
  ProviderAccessResult,
} from '@walkz/contracts';
import { createDefaultWalkzConfig } from '@walkz/contracts';
import type { ReviewContext } from '@walkz/git';
import { createMockProvider } from '@walkz/providers';
import { describe, expect, it, vi } from 'vitest';

import {
  requiresSecuritySpecialist,
  resolvePolicyPacks,
  runSecuritySpecialist,
  WALKZ_SECURITY_PROMPT_VERSION,
} from '../src/index.js';

const checks: DeterministicCheckRun = {
  approval: { status: 'not_required', source: 'none' },
  plannedCount: 0,
  checks: [],
  status: 'complete',
};
const access: ProviderAccessResult = {
  provider: 'mock',
  selectedModel: 'mock/reviewer',
  models: [{
    id: 'mock/reviewer',
    active: true,
    contextWindow: 32_000,
    maxCompletionTokens: 4_000,
    supportsStrictStructuredOutput: true,
  }],
  privacyNotice: 'Local test provider.',
  dataControlsUrl: null,
};
const budget = {
  maxDurationMs: 30_000,
  maxModelTokens: 8_000,
  maxProofAttempts: 0,
  deadlineMs: Date.now() + 30_000,
};
const policies = resolvePolicyPacks(createDefaultWalkzConfig());

function context(reason = 'security-sensitive path'): ReviewContext {
  const diff = 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n';
  return {
    references: {
      mode: 'branch',
      baseRef: 'main',
      baseTipSha: '1'.repeat(40),
      baseSha: '1'.repeat(40),
      headRef: 'HEAD',
      headSha: '2'.repeat(40),
      guidanceSha: '1'.repeat(40),
    },
    changedFiles: [],
    risks: { 'src/auth.ts': { score: 35, reasons: [reason] } },
    diff,
    lineIndex: new Map([['src/auth.ts', new Set([1])]]),
    guidance: { documents: [], bytes: 0, omissions: [] },
    coverage: {
      complete: true,
      changedFileCount: 1,
      selectedFileCount: 1,
      diffBytes: Buffer.byteLength(diff),
      omissions: [],
    },
  };
}

function finding(category: 'security' | 'correctness' = 'security') {
  return {
    category,
    severity: 'high' as const,
    file: 'src/auth.ts',
    line: 1,
    claim: 'The new authorization branch accepts an untrusted identity.',
    failureMechanism: 'A caller can bypass the owner comparison.',
    suggestedProof: 'Call the branch with a different owner.',
    confidence: 0.95,
  };
}

describe('security specialist', () => {
  it('runs only for deterministic security-sensitive risk reasons', () => {
    expect(requiresSecuritySpecialist(context(), policies)).toBe(true);
    expect(requiresSecuritySpecialist(context('source change'), policies)).toBe(false);
  });

  it('adds a changed-line security finding through the normal evidence boundary', async () => {
    const provider = createMockProvider({
      outcomes: [{
        type: 'review',
        review: { findings: [finding()] },
      }],
    });
    const request = vi.fn(provider.requestStructuredSecurityReview!);
    provider.requestStructuredSecurityReview = request;

    const result = await runSecuritySpecialist({
      findings: [],
      context: context(),
      checks,
      policies,
      budget,
      usedModelTokens: 100,
      access,
      provider,
      signal: new AbortController().signal,
      recordedAt: '2026-09-13T10:00:00.000Z',
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      model: 'mock/reviewer',
      promptVersion: WALKZ_SECURITY_PROMPT_VERSION,
    });
    expect(Object.keys(request.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'maxOutputTokens',
      'model',
      'promptVersion',
      'systemPrompt',
      'userPrompt',
    ]);
    expect(request.mock.calls[0]?.[0].systemPrompt).toContain('no tools');
    expect(result.step.status).toBe('complete');
    expect(result.findings).toEqual([
      expect.objectContaining({
        category: 'security',
        file: 'src/auth.ts',
        line: 1,
        evidenceLevel: 'UNVERIFIED',
      }),
    ]);
  });

  it('does not call a provider for an ordinary source change', async () => {
    const provider = createMockProvider();
    const request = vi.fn(provider.requestStructuredSecurityReview!);
    provider.requestStructuredSecurityReview = request;

    const result = await runSecuritySpecialist({
      findings: [],
      context: context('source change'),
      checks,
      policies,
      budget,
      usedModelTokens: 100,
      access,
      provider,
      signal: new AbortController().signal,
      recordedAt: '2026-09-13T10:00:00.000Z',
    });

    expect(request).not.toHaveBeenCalled();
    expect(result.step.status).toBe('not_requested');
  });

  it('fails closed on non-security or invented findings', async () => {
    for (const review of [
      { findings: [finding('correctness')] },
      { findings: [{ ...finding(), line: 99 }] },
    ]) {
      const provider = createMockProvider({
        outcomes: [{ type: 'review', review }],
      });
      const result = await runSecuritySpecialist({
        findings: [],
        context: context(),
        checks,
        policies,
        budget,
        usedModelTokens: 100,
        access,
        provider,
        signal: new AbortController().signal,
        recordedAt: '2026-09-13T10:00:00.000Z',
      });

      expect(result.step).toMatchObject({
        status: 'incomplete',
        failureCode: 'invalid_response',
      });
      expect(result.findings).toEqual([]);
    }
  });

  it('refuses to exceed the remaining shared model budget', async () => {
    const provider = createMockProvider({
      outcomes: [{ type: 'review', review: { findings: [] } }],
    });
    const request = vi.fn(provider.requestStructuredSecurityReview!);
    provider.requestStructuredSecurityReview = request;

    const result = await runSecuritySpecialist({
      findings: [],
      context: context(),
      checks,
      policies,
      budget,
      usedModelTokens: budget.maxModelTokens,
      access,
      provider,
      signal: new AbortController().signal,
      recordedAt: '2026-09-13T10:00:00.000Z',
    });

    expect(request).not.toHaveBeenCalled();
    expect(result.step).toMatchObject({
      status: 'incomplete',
      failureCode: 'budget_exhausted',
    });
  });
});
