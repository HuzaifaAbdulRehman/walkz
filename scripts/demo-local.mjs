import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReview } from '../apps/cli/dist/index.js';
import { createMockProvider } from '../packages/providers/dist/index.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(projectRoot, 'tests', 'golden', 'broken');

function git(repository, ...args) {
  execFileSync('git', args, {
    cwd: repository,
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'walkz demo '));
  await mkdir(join(repository, 'src'));
  await Promise.all([
    cp(
      join(fixtureRoot, 'base', 'walkz.config.json'),
      join(repository, 'walkz.config.json'),
    ),
    cp(
      join(fixtureRoot, 'base', 'check.mjs'),
      join(repository, 'check.mjs'),
    ),
    cp(
      join(fixtureRoot, 'base', 'src', 'value.mjs'),
      join(repository, 'src', 'value.mjs'),
    ),
  ]);
  git(repository, 'init', '--quiet', '-b', 'main');
  git(repository, 'config', 'user.name', 'Walkz Demo');
  git(repository, 'config', 'user.email', 'walkz@example.test');
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'base');
  git(repository, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(
    join(repository, 'src', 'value.mjs'),
    await readFile(
      join(fixtureRoot, 'head', 'src', 'value.mjs'),
      'utf8',
    ),
    'utf8',
  );
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'introduce boundary regression');
  return repository;
}

const startedAt = performance.now();
const repository = await createRepository();
try {
  const review = await runReview({
    cwd: repository,
    provider: createMockProvider({
      outcomes: [
        {
          type: 'review',
          review: {
            findings: [
              {
                category: 'correctness',
                severity: 'high',
                file: 'src/value.mjs',
                line: 1,
                claim: 'Zero crosses the wrong boundary.',
                failureMechanism:
                  'The strict comparison returns one for zero.',
                suggestedProof: 'Run the configured boundary check.',
                confidence: 0.98,
              },
            ],
          },
        },
      ],
    }),
    onProviderAccess: (access) => {
      process.stderr.write('Provider privacy: ' + access.privacyNotice + '\n');
    },
  });
  process.stdout.write(review.output);
  process.stdout.write(
    'Demo time: ' + Math.round(performance.now() - startedAt) + ' ms\n',
  );
  if (review.exitCode !== 1 || review.review.decision.verdict !== 'FIX') {
    throw new Error('The broken demo did not return FIX.');
  }
} finally {
  await rm(repository, { recursive: true, force: true });
}
