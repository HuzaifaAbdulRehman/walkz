import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseReleaseManifest } from './release-artifacts.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const knownReviewId = '70000000-0000-4000-8000-000000000074';
const knownReviewMarker = 'phase-7.4-known-review';
const maximumBackupBytes = 64 * 1_024 * 1_024;
const serviceEnvironmentNames = {
  api: 'WALKZ_API_IMAGE',
  web: 'WALKZ_WEB_IMAGE',
  worker: 'WALKZ_WORKER_IMAGE',
};

const seedSql = `
BEGIN;
INSERT INTO github_installations (id, github_id, account_login)
VALUES ('70000000-0000-4000-8000-000000000071', 700074, 'walkz-recovery');
INSERT INTO repositories (id, installation_id, github_id, owner_login, repository_name)
VALUES (
  '70000000-0000-4000-8000-000000000072',
  '70000000-0000-4000-8000-000000000071',
  700075,
  'walkz-recovery',
  'disposable'
);
INSERT INTO repository_configs (id, repository_id, schema_version, config_hash, config)
VALUES (
  '70000000-0000-4000-8000-000000000073',
  '70000000-0000-4000-8000-000000000072',
  1,
  '${'7'.repeat(64)}',
  '{}'::jsonb
);
INSERT INTO review_runs (
  id, repository_id, pull_request_id, config_id, config_hash, base_sha,
  head_sha, provider, model, prompt_version, status, result_summary
)
VALUES (
  '${knownReviewId}',
  '70000000-0000-4000-8000-000000000072',
  NULL,
  '70000000-0000-4000-8000-000000000073',
  '${'7'.repeat(64)}',
  '${'a'.repeat(40)}',
  '${'b'.repeat(40)}',
  'groq',
  'recovery-drill',
  'recovery-v1',
  'queued',
  '${knownReviewMarker}'
);
COMMIT;
`;

function resolveRepositoryPath(value, description) {
  const path = resolve(repositoryRoot, value);
  const child = relative(repositoryRoot, path);
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`${description} must stay inside the repository.`);
  }
  return path;
}

export function parseRecoveryOptions(arguments_) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      'baseline-manifest': { type: 'string' },
      'candidate-manifest': {
        type: 'string',
        default: 'artifacts/release-manifest.json',
      },
      'compose-file': { type: 'string', default: 'infra/compose.production.yml' },
      'env-file': { type: 'string', default: 'infra/.env.production' },
      output: { type: 'string', default: 'artifacts/recovery-drill.json' },
      'wait-seconds': { type: 'string', default: '180' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values['baseline-manifest'] === undefined) {
    throw new Error('--baseline-manifest is required.');
  }
  const waitSeconds = Number(values['wait-seconds']);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 30 || waitSeconds > 600) {
    throw new Error('--wait-seconds must be an integer from 30 through 600.');
  }
  return {
    baselineManifestPath: resolveRepositoryPath(
      values['baseline-manifest'],
      'The baseline manifest',
    ),
    candidateManifestPath: resolveRepositoryPath(
      values['candidate-manifest'],
      'The candidate manifest',
    ),
    composeFile: resolveRepositoryPath(values['compose-file'], 'The Compose file'),
    envFile: resolveRepositoryPath(values['env-file'], 'The environment file'),
    outputPath: resolveRepositoryPath(values.output, 'The recovery report'),
    waitSeconds,
  };
}

export function validateRecoveryPair(baseline, candidate) {
  const older = parseReleaseManifest(baseline);
  const newer = parseReleaseManifest(candidate);
  if (older.sourceTree !== 'clean' || newer.sourceTree !== 'clean') {
    throw new Error('Recovery drills require clean release manifests.');
  }
  if (older.sourceRevision === newer.sourceRevision) {
    throw new Error('Baseline and candidate revisions must be different.');
  }
  for (const service of Object.keys(serviceEnvironmentNames)) {
    const before = older.images.find((image) => image.service === service);
    const after = newer.images.find((image) => image.service === service);
    if (before.digest === after.digest) {
      throw new Error(`${service} must have distinct baseline and candidate images.`);
    }
  }
  return { baseline: older, candidate: newer };
}

export function createRecoveryIdentity(suffix) {
  if (!/^[a-z0-9]{8,24}$/.test(suffix)) {
    throw new Error('The recovery drill suffix is invalid.');
  }
  const project = `walkz-recovery-${suffix}`;
  return {
    project,
    postgresVolume: `${project}-postgres`,
    proofVolume: `${project}-proof`,
  };
}

export function createReleaseEnvironment(manifest, identity, environment = process.env) {
  const result = {
    ...environment,
    WALKZ_POSTGRES_VOLUME: identity.postgresVolume,
    WALKZ_PROOF_VOLUME: identity.proofVolume,
  };
  for (const [service, name] of Object.entries(serviceEnvironmentNames)) {
    result[name] = manifest.images.find((image) => image.service === service).digest;
  }
  return result;
}

function commandRunner(command, arguments_, options = {}) {
  try {
    return execFileSync(command, arguments_, {
      cwd: repositoryRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1_000,
      maxBuffer: options.maxBuffer ?? 4 * 1_024 * 1_024,
      encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
      env: options.env ?? process.env,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch {
    throw new Error(`${options.label ?? command} failed.`);
  }
}

function composeArguments(options, identity, arguments_) {
  return [
    'compose',
    '--project-name', identity.project,
    '--env-file', options.envFile,
    '--file', options.composeFile,
    ...arguments_,
  ];
}

function createAdapter(options, identity, run = commandRunner) {
  return {
    docker(arguments_, settings = {}) {
      return run('docker', arguments_, settings);
    },
    compose(arguments_, environment, settings = {}) {
      return run('docker', composeArguments(options, identity, arguments_), {
        ...settings,
        env: environment,
      });
    },
  };
}

function imageRevision(adapter, image, environment) {
  const output = adapter.docker([
    'image',
    'inspect',
    image.digest,
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.walkz.service"}}',
  ], { env: environment, label: `Inspect ${image.service} image` });
  const [revision, service] = output.trim().split('|');
  return { revision, service };
}

function assertReleaseImages(adapter, manifest, environment) {
  for (const image of manifest.images) {
    const inspected = imageRevision(adapter, image, environment);
    if (
      inspected.revision !== manifest.sourceRevision ||
      inspected.service !== image.service
    ) {
      throw new Error(`${image.service} image identity does not match its manifest.`);
    }
  }
}

function queryReview(adapter, environment) {
  return adapter.compose([
    'exec', '--no-TTY', 'postgres',
    'psql', '--no-psqlrc', '--tuples-only', '--no-align',
    '--set=ON_ERROR_STOP=1', '--username=walkz', '--dbname=walkz',
    '--command',
    `SELECT id || '|' || status || '|' || result_summary FROM review_runs WHERE id = '${knownReviewId}';`,
  ], environment, { label: 'Read recovery review' }).trim();
}

function assertReview(adapter, environment, status) {
  const expected = `${knownReviewId}|${status}|${knownReviewMarker}`;
  if (queryReview(adapter, environment) !== expected) {
    throw new Error(`The known review record was not restored as ${status}.`);
  }
}

function migrationCount(adapter, environment) {
  const output = adapter.compose([
    'exec', '--no-TTY', 'postgres',
    'psql', '--no-psqlrc', '--tuples-only', '--no-align',
    '--set=ON_ERROR_STOP=1', '--username=walkz', '--dbname=walkz',
    '--command', 'SELECT count(*) FROM walkz_migrations;',
  ], environment, { label: 'Read migration count' }).trim();
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('The migration ledger is missing or invalid.');
  }
  return count;
}

function assertProjectRemoved(adapter, identity, environment) {
  const containers = adapter.docker([
    'ps', '--all', '--quiet', '--filter',
    `label=com.docker.compose.project=${identity.project}`,
  ], { env: environment, label: 'Verify recovery container cleanup' }).trim();
  const networks = adapter.docker([
    'network', 'ls', '--quiet', '--filter',
    `label=com.docker.compose.project=${identity.project}`,
  ], { env: environment, label: 'Verify recovery network cleanup' }).trim();
  const volumes = adapter.docker(
    ['volume', 'ls', '--quiet'],
    { env: environment, label: 'Verify recovery volume cleanup' },
  ).split(/\r?\n/).filter(Boolean);
  if (
    containers.length > 0 ||
    networks.length > 0 ||
    volumes.includes(identity.postgresVolume) ||
    volumes.includes(identity.proofVolume)
  ) {
    throw new Error('Disposable recovery resources remain after cleanup.');
  }
}

function inspectRunningRevision(adapter, environment, service, expected) {
  const containerId = adapter.compose(
    ['ps', '--quiet', service],
    environment,
    { label: `Locate ${service} container` },
  ).trim();
  if (containerId.length === 0) throw new Error(`${service} is not running.`);
  const revision = adapter.docker([
    'inspect', containerId, '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  ], { env: environment, label: `Inspect ${service} revision` }).trim();
  if (revision !== expected) {
    throw new Error(`${service} is not running the expected revision.`);
  }
}

async function loadManifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('A release manifest could not be read.');
  }
  return value;
}

export async function runRecoveryDrill(options, dependencies = {}) {
  const startedAt = Date.now();
  const identity = createRecoveryIdentity(
    dependencies.suffix ?? randomBytes(6).toString('hex'),
  );
  const manifests = validateRecoveryPair(
    dependencies.baseline ?? await loadManifest(options.baselineManifestPath),
    dependencies.candidate ?? await loadManifest(options.candidateManifestPath),
  );
  const baselineEnvironment = createReleaseEnvironment(
    manifests.baseline,
    identity,
    dependencies.environment,
  );
  const candidateEnvironment = createReleaseEnvironment(
    manifests.candidate,
    identity,
    dependencies.environment,
  );
  const adapter = dependencies.adapter ?? createAdapter(options, identity);
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'walkz-recovery-'));
  const backupPath = resolve(temporaryDirectory, 'walkz.dump');
  let backupBytes = 0;
  let backupSha256 = '';
  let baselineMigrations = 0;
  let candidateMigrations = 0;
  let operationError;
  let cleanupError;
  let report;

  try {
    assertReleaseImages(adapter, manifests.baseline, baselineEnvironment);
    assertReleaseImages(adapter, manifests.candidate, candidateEnvironment);
    const existing = adapter.docker([
      'ps', '--all', '--quiet', '--filter',
      `label=com.docker.compose.project=${identity.project}`,
    ], { label: 'Check recovery project isolation' }).trim();
    if (existing.length > 0) throw new Error('The recovery project already exists.');

    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'postgres', 'redis',
    ], baselineEnvironment, { label: 'Start baseline data services' });
    adapter.compose(
      ['run', '--rm', '--no-deps', 'migrate'],
      baselineEnvironment,
      { label: 'Migrate baseline database' },
    );
    baselineMigrations = migrationCount(adapter, baselineEnvironment);
    adapter.compose([
      'exec', '--no-TTY', 'postgres',
      'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1',
      '--username=walkz', '--dbname=walkz', '--command', seedSql,
    ], baselineEnvironment, { label: 'Seed known review record' });
    assertReview(adapter, baselineEnvironment, 'queued');

    const backup = adapter.compose([
      'exec', '--no-TTY', 'postgres',
      'pg_dump', '--username=walkz', '--dbname=walkz', '--format=custom',
      '--no-owner', '--no-privileges',
    ], baselineEnvironment, {
      encoding: null,
      maxBuffer: maximumBackupBytes,
      label: 'Create PostgreSQL backup',
    });
    backupBytes = backup.byteLength;
    backupSha256 = createHash('sha256').update(backup).digest('hex');
    if (backupBytes === 0 || backupBytes >= maximumBackupBytes) {
      throw new Error('The recovery backup is empty or exceeds the drill limit.');
    }
    await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
    const archive = adapter.compose([
      'exec', '--no-TTY', 'postgres', 'pg_restore', '--list',
    ], baselineEnvironment, {
      input: backup,
      label: 'Validate PostgreSQL backup',
    });
    if (!archive.includes('TABLE DATA public review_runs')) {
      throw new Error('The backup does not contain review run data.');
    }

    adapter.compose(
      ['down', '--volumes', '--remove-orphans', '--timeout', '30'],
      baselineEnvironment,
      { label: 'Remove baseline data services' },
    );
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'postgres',
    ], candidateEnvironment, { label: 'Start restore database' });
    adapter.compose([
      'exec', '--no-TTY', 'postgres',
      'pg_restore', '--clean', '--if-exists', '--exit-on-error',
      '--no-owner', '--no-privileges', '--username=walkz', '--dbname=walkz',
    ], candidateEnvironment, {
      input: backup,
      label: 'Restore PostgreSQL backup',
    });
    adapter.compose(
      ['run', '--rm', '--no-deps', 'migrate'],
      candidateEnvironment,
      { label: 'Migrate restored database' },
    );
    candidateMigrations = migrationCount(adapter, candidateEnvironment);
    if (candidateMigrations < baselineMigrations) {
      throw new Error('The restored database lost migration history.');
    }
    assertReview(adapter, candidateEnvironment, 'queued');

    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'redis',
    ], candidateEnvironment, { label: 'Start replacement queue' });
    const reconciliation = adapter.compose(
      ['run', '--rm', '--no-deps', 'reconcile'],
      candidateEnvironment,
      { label: 'Reconcile durable queues' },
    );
    if (!/reviews=1(?:,|\.)/.test(reconciliation)) {
      throw new Error('The queued review was not reconciled from PostgreSQL.');
    }
    const queued = adapter.compose([
      'exec', '--no-TTY', 'redis', 'redis-cli', '--raw', 'EXISTS',
      `bull:walkz-reviews:${knownReviewId}`,
    ], candidateEnvironment, { label: 'Verify reconciled queue job' }).trim();
    if (queued !== '1') throw new Error('The reconciled review job is missing.');

    adapter.compose([
      'exec', '--no-TTY', 'postgres',
      'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1',
      '--username=walkz', '--dbname=walkz', '--command',
      `UPDATE review_runs SET status = 'cancelled', completed_at = now() WHERE id = '${knownReviewId}';`,
    ], candidateEnvironment, { label: 'Disarm synthetic review job' });
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'api', 'worker',
    ], candidateEnvironment, { label: 'Start candidate application' });
    for (const service of ['api', 'worker']) {
      inspectRunningRevision(
        adapter,
        candidateEnvironment,
        service,
        manifests.candidate.sourceRevision,
      );
    }

    adapter.compose(
      ['run', '--rm', '--no-deps', 'migrate'],
      baselineEnvironment,
      { label: 'Check rollback migration compatibility' },
    );
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      '--force-recreate', '--no-deps', 'api', 'worker',
    ], baselineEnvironment, { label: 'Roll back application revision' });
    for (const service of ['api', 'worker']) {
      inspectRunningRevision(
        adapter,
        baselineEnvironment,
        service,
        manifests.baseline.sourceRevision,
      );
    }
    assertReview(adapter, baselineEnvironment, 'cancelled');
    if (migrationCount(adapter, baselineEnvironment) !== candidateMigrations) {
      throw new Error('Rollback changed the restored migration ledger.');
    }

    report = {
      schemaVersion: 1,
      outcome: 'passed',
      project: identity.project,
      baselineRevision: manifests.baseline.sourceRevision,
      candidateRevision: manifests.candidate.sourceRevision,
      knownReviewId,
      backup: {
        bytes: backupBytes,
        sha256: backupSha256,
        retained: false,
      },
      migrations: {
        baseline: baselineMigrations,
        candidate: candidateMigrations,
        afterRollback: candidateMigrations,
      },
      queueRecovery: { reviews: 1 },
      finalRevision: manifests.baseline.sourceRevision,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      adapter.compose(
        ['down', '--volumes', '--remove-orphans', '--timeout', '30'],
        candidateEnvironment,
        { label: 'Clean recovery drill resources' },
      );
      assertProjectRemoved(adapter, identity, candidateEnvironment);
    } catch (error) {
      cleanupError = error;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  if (cleanupError !== undefined) {
    throw new AggregateError(
      operationError === undefined ? [cleanupError] : [operationError, cleanupError],
      'The recovery drill failed and cleanup was incomplete.',
    );
  }
  if (operationError !== undefined) throw operationError;
  if (report === undefined) throw new Error('The recovery drill did not produce a report.');
  report.durationMs = Date.now() - startedAt;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

async function main() {
  try {
    const options = parseRecoveryOptions(process.argv.slice(2));
    const report = await runRecoveryDrill(options);
    process.stdout.write(
      `Recovery drill passed: restored ${report.knownReviewId}, reconciled one review, ` +
      `and rolled back to ${report.finalRevision.slice(0, 12)}. Temporary backup deleted.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Recovery drill failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
