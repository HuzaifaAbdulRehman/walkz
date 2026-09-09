import { z } from 'zod';

import { parseReviewCheckPayload, type ReviewCheckPayload } from './checks.js';

const findingSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().trim().min(1).max(1_024),
  })
  .strict();

const reviewResultSchema = z
  .object({
    baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    headSha: z.string().regex(/^[a-f0-9]{40}$/i),
    verdict: z.enum(['SHIP', 'FIX', 'HUMAN', 'INCONCLUSIVE', 'ERROR']),
    summary: z.string().trim().min(1).max(65_536),
    findings: z.array(findingSchema).max(50),
  })
  .strict()
  .refine((result) => result.baseSha !== result.headSha, {
    message: 'Review results must compare distinct revisions.',
    path: ['headSha'],
  });

function renderPlainCheckText(value: string, maxLength: number): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replaceAll('\\', '\\\\')
    .replace(/([!"#$%()*+,\-./:;=?[\]^_\x60{|}~])/g, '\\$1');
  return escaped.length <= maxLength
    ? escaped
    : `${escaped.slice(0, maxLength - 1)}…`;
}

export function buildReviewCheckPayload(input: unknown): ReviewCheckPayload {
  const result = reviewResultSchema.parse(input);
  const conclusion = result.verdict === 'SHIP'
    ? 'success'
    : result.verdict === 'FIX'
      ? 'failure'
      : result.verdict === 'ERROR'
        ? 'timed_out'
        : 'neutral';
  return parseReviewCheckPayload({
    name: 'Walkz / review',
    baseSha: result.baseSha,
    headSha: result.headSha,
    status: 'completed',
    conclusion,
    summary: renderPlainCheckText(result.summary, 65_536),
    annotations: result.findings.map((finding) => ({
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      level: finding.severity === 'critical' || finding.severity === 'high'
        ? 'failure'
        : finding.severity === 'medium'
          ? 'warning'
          : 'notice',
      message: renderPlainCheckText(finding.summary, 1_024),
    })),
  });
}
