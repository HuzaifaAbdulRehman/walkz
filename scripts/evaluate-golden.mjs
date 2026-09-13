import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGoldenProofFixtureManifest,
  parseGoldenProofBaseline,
} from '../packages/contracts/dist/index.js';
import {
  compareGoldenProofBaseline,
  createProofPlan,
  digestProofCommand,
  evaluateGoldenProofs,
  getReviewLanguageAdapter,
  listReviewLanguageAdapters,
  normalizeFinding,
  runAndAssessCounterfactualProof,
} from '../packages/engine/dist/index.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const goldenRoot = join(projectRoot, 'tests', 'golden');
const manifestBytes = await readFile(join(goldenRoot, 'proof-manifest.json'), 'utf8');
const manifest = parseGoldenProofFixtureManifest(JSON.parse(manifestBytes));
const baseline = parseGoldenProofBaseline(JSON.parse(
  await readFile(join(goldenRoot, 'proof-baseline.json'), 'utf8'),
));
const limits = {
  timeoutMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  memoryBytes: 256 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 64,
  maxWritableBytes: 1024 * 1_024,
};
const proofBudget = {
  maxAttempts: 1,
  maxTotalDurationMs: 30_000,
  maxAttemptDurationMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  maxArtifactBytes: 1024 * 1_024,
};
const budget = {
  ...proofBudget,
  deadlineMs: Date.now() + 60_000,
};
const workspaceLimits = { maxFiles: 100, maxBytes: 1024 * 1_024 };
const temporaryRepositories = new Set();

function imageForLanguage(language) {
  const adapter = getReviewLanguageAdapter(language);
  if (language === 'javascript-typescript') {
    return process.env.WALKZ_DOCKER_TEST_IMAGE ??
      adapter.proofRuntime.defaultContainerImage;
  }
  if (language === 'python') {
    return process.env.WALKZ_PYTHON_DOCKER_TEST_IMAGE ??
      adapter.proofRuntime.defaultContainerImage;
  }
  throw new Error(`No golden proof image is configured for ${language}.`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot hash a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}';
  }
  throw new Error('Cannot hash an unsupported value.');
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function git(repository, ...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  }).trim();
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(join(source, entry.name), target);
    } else if (entry.isFile()) {
      await copyFile(join(source, entry.name), target);
    } else {
      throw new Error('Golden fixtures must contain only regular files and directories.');
    }
  }
}

async function createFixtureRepository(fixture) {
  const repository = await mkdtemp(join(tmpdir(), 'walkz golden proof '));
  temporaryRepositories.add(repository);
  const fixtureRoot = join(goldenRoot, fixture);
  await copyTree(join(fixtureRoot, 'base'), repository);
  git(repository, 'init', '--quiet', '-b', 'main');
  git(repository, 'config', 'core.autocrlf', 'false');
  git(repository, 'config', 'user.name', 'Walkz Golden');
  git(repository, 'config', 'user.email', 'walkz@example.test');
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(repository, 'rev-parse', 'HEAD');
  git(repository, 'checkout', '--quiet', '-b', 'feature');
  await copyTree(join(fixtureRoot, 'head'), repository);
  git(repository, 'add', '--all', '--renormalize');
  if (git(repository, 'diff', '--cached', '--name-only').length === 0) {
    throw new Error('Golden fixture head does not change the base revision.');
  }
  git(repository, 'commit', '--quiet', '-m', 'head');
  return { repository, baseSha, headSha: git(repository, 'rev-parse', 'HEAD') };
}

function percentage(value) {
  return value === null ? 'n/a' : (value * 100).toFixed(1) + '%';
}

async function evaluate() {
  const records = [];
  for (const fixture of manifest.cases) {
    const adapter = getReviewLanguageAdapter(fixture.language);
    const image = imageForLanguage(fixture.language);
    const command = adapter.proofRuntime.command;
    const commandDigest = digestProofCommand(command);
    const authorization = {
      authorizedCommandDigests: new Set([commandDigest]),
    };
    const { repository, baseSha, headSha } = await createFixtureRepository(
      fixture.fixture,
    );
    const finding = normalizeFinding(fixture.finding);
    const plan = createProofPlan(
      {
        runId: 'golden-' + fixture.id,
        findingFingerprint: finding.fingerprint,
        baseSha,
        headSha,
        containerImage: image,
        command,
        files: [
          {
            path: adapter.proofRuntime.reproducerPath,
            content: fixture.reproducerSource,
          },
        ],
        limits,
      },
      authorization,
      budget,
    );
    const startedAt = performance.now();
    const proof = await runAndAssessCounterfactualProof(finding, plan, {
      repositoryRoot: repository,
      authorization,
      budget,
      workspaceLimits,
    });
    records.push({
      id: fixture.id,
      fixture: fixture.fixture,
      language: fixture.language,
      expected: fixture.expected,
      classification: proof.assessment.classification,
      baseSha,
      headSha,
      proofDurationMs: Math.round(performance.now() - startedAt),
      provider: null,
      model: null,
      promptVersion: null,
      usage: null,
    });
  }
  return evaluateGoldenProofs(records);
}

try {
  const evaluation = await evaluate();
  const metrics = evaluation.metrics;
  const codeRevision = git(projectRoot, 'rev-parse', 'HEAD');
  const languageAdapters = listReviewLanguageAdapters().map((adapter) => ({
    id: adapter.id,
    containerImage: imageForLanguage(adapter.id),
    command: adapter.proofRuntime.command,
    commandDigest: digestProofCommand(adapter.proofRuntime.command),
    reproducerPath: adapter.proofRuntime.reproducerPath,
  }));
  const behavior = {
    schemaVersion: 1,
    suiteId: baseline.suiteId,
    codeRevision,
    fixtureManifestHash: sha256(manifest),
    languageAdapters,
    limits,
    proofBudget,
    workspaceLimits,
    provider: null,
    model: null,
    promptVersion: null,
  };
  const behaviorFingerprint = sha256(behavior);
  const comparison = compareGoldenProofBaseline(baseline, evaluation);
  const report = { behavior, behaviorFingerprint, ...evaluation, comparison };
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      [
        'Walkz golden proof evaluation',
        'Cases: ' + metrics.caseCount,
        'Catch rate: ' + percentage(metrics.catchRate),
        'False-positive rate: ' + percentage(metrics.falsePositiveRate),
        'Proof rate: ' + percentage(metrics.proofRate),
        'Proof time: ' + metrics.totalProofDurationMs + ' ms',
        'Provider invocations: ' + metrics.modelInvocationCount,
      ].join('\n') + '\n',
    );
  }
  if (
    metrics.falsePositives !== 0 ||
    metrics.falseNegatives !== 0 ||
    metrics.incompleteCount !== 0 ||
    !comparison.passed
  ) {
    process.exitCode = 1;
  }
} finally {
  await Promise.all(
    [...temporaryRepositories].map((repository) =>
      rm(repository, { recursive: true, force: true }),
    ),
  );
}
