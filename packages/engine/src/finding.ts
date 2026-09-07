import { createHash } from 'node:crypto';

import type {
  Finding,
  ModelFinding,
} from '@walkz/contracts';
import { modelFindingSchema } from '@walkz/contracts';
import type { DiffLineIndex } from '@walkz/git';

const INVISIBLE_CODEPOINTS =
  /[\u200B-\u200D\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PATH_CONTROLS = /[\u0000-\u001F\u007F]/;

export type FindingLocationFailure =
  | 'file_not_changed'
  | 'line_not_changed'
  | 'range_not_changed';

export type FindingLocationValidation =
  | { valid: true }
  | { valid: false; reason: FindingLocationFailure };

function normalizeText(value: string, field: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(INVISIBLE_CODEPOINTS, '')
    .replace(UNSAFE_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) {
    throw new Error(field + ' must contain visible text.');
  }
  return normalized;
}

function normalizeFindingPath(value: string): string {
  const withoutInvisible = value.replace(INVISIBLE_CODEPOINTS, '');
  if (withoutInvisible !== value || PATH_CONTROLS.test(value)) {
    throw new Error('Finding paths cannot contain invisible control characters.');
  }
  let slashPath = value.normalize('NFC').replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:\/|\/)/.test(slashPath)) {
    throw new Error('Finding paths must be relative.');
  }
  if (slashPath.startsWith('./')) {
    slashPath = slashPath.slice(2);
  }
  const segments = slashPath.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('Finding paths must stay inside the repository.');
  }
  return segments.join('/');
}

type FingerprintInput = Pick<
  Finding,
  'category' | 'file' | 'line' | 'endLine' | 'claim' | 'failureMechanism'
>;

export function fingerprintFinding(finding: FingerprintInput): string {
  const canonical = JSON.stringify([
    finding.category,
    normalizeFindingPath(finding.file),
    finding.line,
    finding.endLine ?? null,
    normalizeText(finding.claim, 'Finding claim'),
    normalizeText(finding.failureMechanism, 'Failure mechanism'),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function normalizeFinding(input: unknown): Finding {
  const finding: ModelFinding = modelFindingSchema.parse(input);
  const normalized = {
    category: finding.category,
    severity: finding.severity,
    file: normalizeFindingPath(finding.file),
    line: finding.line,
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    claim: normalizeText(finding.claim, 'Finding claim'),
    failureMechanism: normalizeText(
      finding.failureMechanism,
      'Failure mechanism',
    ),
    suggestedProof: normalizeText(finding.suggestedProof, 'Suggested proof'),
  };
  return {
    ...normalized,
    fingerprint: fingerprintFinding(normalized),
    lifecycleStatus: 'unverified',
    evidenceLevel: 'UNVERIFIED',
    advisoryConfidence: finding.confidence,
    evidence: [],
    dismissal: null,
    fix: null,
  };
}

export function validateFindingLocation(
  finding: Pick<Finding, 'file' | 'line' | 'endLine'>,
  lineIndex: DiffLineIndex,
): FindingLocationValidation {
  const changedLines = lineIndex.get(finding.file);
  if (changedLines === undefined) {
    return { valid: false, reason: 'file_not_changed' };
  }
  if (!changedLines.has(finding.line)) {
    return { valid: false, reason: 'line_not_changed' };
  }
  if (finding.endLine !== undefined) {
    const rangeSize = finding.endLine - finding.line + 1;
    if (!Number.isSafeInteger(rangeSize) || rangeSize > changedLines.size) {
      return { valid: false, reason: 'range_not_changed' };
    }
    let changedLineCount = 0;
    for (const line of changedLines) {
      if (line >= finding.line && line <= finding.endLine) {
        changedLineCount += 1;
      }
    }
    if (changedLineCount !== rangeSize) {
      return { valid: false, reason: 'range_not_changed' };
    }
  }
  return { valid: true };
}
