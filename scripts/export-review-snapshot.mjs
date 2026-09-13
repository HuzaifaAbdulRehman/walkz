import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createDatabasePool,
  exportReviewEvaluationSnapshot,
} from '../packages/persistence/dist/index.js';

const { values } = parseArgs({
  options: {
    'actor-user': { type: 'string' },
    repository: { type: 'string' },
    cohort: { type: 'string' },
    after: { type: 'string' },
    before: { type: 'string' },
    limit: { type: 'string', default: '250' },
    output: { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

const required = [
  ['--actor-user', values['actor-user']],
  ['--repository', values.repository],
  ['--cohort', values.cohort],
  ['--after', values.after],
  ['--before', values.before],
  ['--output', values.output],
];
const missing = required
  .filter(([, value]) => value === undefined || value.trim().length === 0)
  .map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`Missing required options: ${missing.join(', ')}`);
}
if (process.env.DATABASE_URL === undefined) {
  throw new Error('DATABASE_URL is required to export hosted review metadata.');
}

const createdAfter = new Date(values.after);
const createdBefore = new Date(values.before);
const limit = Number(values.limit);
if (Number.isNaN(createdAfter.valueOf()) || Number.isNaN(createdBefore.valueOf())) {
  throw new Error('--after and --before must be ISO-8601 timestamps.');
}
if (!Number.isInteger(limit)) {
  throw new Error('--limit must be an integer.');
}

const database = createDatabasePool({
  connectionString: process.env.DATABASE_URL,
  maxConnections: 1,
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 10_000,
});
try {
  const snapshot = await exportReviewEvaluationSnapshot(database, {
    actorUserId: values['actor-user'],
    repositoryId: values.repository,
    cohortId: values.cohort,
    createdAfter,
    createdBefore,
    limit,
  });
  if (snapshot === null) {
    throw new Error('No authorized, eligible review runs matched this cohort.');
  }

  const outputPath = resolve(values.output);
  await writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`Wrote ${snapshot.runs.length} review runs to ${outputPath}\n`);
} finally {
  await database.end();
}
