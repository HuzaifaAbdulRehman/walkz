import { basename, extname } from 'node:path';

import type { ChangedFile, ChangeRisk } from './types.js';

const HIGH_RISK_NAMES = new Set([
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1', '.sh']);

export function calculateChangeRisk(file: ChangedFile): ChangeRisk {
  const normalizedPath = file.path.replaceAll('\\', '/').toLowerCase();
  const reasons: string[] = [];
  let score = 10;

  if (HIGH_RISK_NAMES.has(basename(normalizedPath))) {
    score += 35;
    reasons.push('dependency or package metadata');
  }
  if (
    normalizedPath.startsWith('.github/workflows/') ||
    normalizedPath.includes('/migrations/') ||
    normalizedPath.startsWith('migrations/')
  ) {
    score += 30;
    reasons.push('delivery or data migration path');
  }
  if (/(^|\/)(auth|crypto|security|permissions?)(\/|\.|$)/.test(normalizedPath)) {
    score += 25;
    reasons.push('security-sensitive path');
  }
  if (
    /(^|\/)(config|infra)(\/|\.|$)/.test(normalizedPath) ||
    EXECUTABLE_EXTENSIONS.has(extname(normalizedPath))
  ) {
    score += 15;
    reasons.push('configuration or executable change');
  }
  if (
    file.status === 'added' ||
    file.status === 'deleted' ||
    file.status === 'type_changed'
  ) {
    score += 10;
    reasons.push('structural file change');
  }
  if (file.kind !== 'text') {
    score += 20;
    reasons.push('content cannot be reviewed as text');
  }
  const changedLines = (file.additions ?? 0) + (file.deletions ?? 0);
  if (changedLines >= 500) {
    score += 20;
    reasons.push('large change');
  } else if (changedLines >= 100) {
    score += 10;
    reasons.push('medium-sized change');
  }
  if (/(^|\/)(test|tests|__tests__)(\/|\.)/.test(normalizedPath)) {
    score -= 10;
    reasons.push('test-only path');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}
