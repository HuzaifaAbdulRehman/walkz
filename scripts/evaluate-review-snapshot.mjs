import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { evaluateReviewSnapshot } from '../packages/engine/dist/index.js';

const maximumSnapshotBytes = 5 * 1_024 * 1_024;
const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.input === undefined || values.input.trim().length === 0) {
  throw new Error('Use --input with a review evaluation snapshot path.');
}

const inputPath = resolve(values.input);
const inputStat = await stat(inputPath);
if (!inputStat.isFile() || inputStat.size > maximumSnapshotBytes) {
  throw new Error('The review evaluation snapshot must be a file no larger than 5 MiB.');
}

const evaluation = evaluateReviewSnapshot(JSON.parse(await readFile(inputPath, 'utf8')));

if (values.json) {
  process.stdout.write(JSON.stringify(evaluation, null, 2) + '\n');
} else {
  const lines = [
    `Walkz review evaluation: ${evaluation.cohortId}`,
    `Cohort hash: ${evaluation.cohortHash}`,
  ];
  for (const candidate of evaluation.candidates) {
    const falsePositiveRate = candidate.metrics.falsePositiveRate === null
      ? 'unlabeled'
      : `${(candidate.metrics.falsePositiveRate * 100).toFixed(1)}%`;
    const proofRate = candidate.metrics.proofRate === null
      ? 'not attempted'
      : `${(candidate.metrics.proofRate * 100).toFixed(1)}%`;
    lines.push(
      `${candidate.provider} / ${candidate.model} / ${candidate.promptVersion}`,
      `  Runs: ${candidate.metrics.runCount}`,
      `  Labeled false-positive rate: ${falsePositiveRate}`,
      `  Proof rate: ${proofRate}`,
      `  Tokens: ${candidate.metrics.totalTokens}`,
      `  Average model latency: ${candidate.metrics.averageModelLatencyMs.toFixed(1)} ms`,
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}
