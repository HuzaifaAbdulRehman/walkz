import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseReleaseManifest } from './release-artifacts.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const serviceEnvironmentNames = {
  api: 'WALKZ_API_IMAGE',
  web: 'WALKZ_WEB_IMAGE',
  worker: 'WALKZ_WORKER_IMAGE',
};
const projectPattern = /^walkz-beta-[a-f0-9]{12}$/;
const stateSchemaVersion = 2;

function resolveRepositoryPath(value, description) {
  const path = resolve(repositoryRoot, value);
  const child = relative(repositoryRoot, path);
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`${description} must stay inside the repository.`);
  }
  return path;
}

function parseInteger(value, description, minimum, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${description} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${description} must be from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function parsePublicUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('--public-url must be an HTTPS origin without a path.');
  }
  return url.origin;
}

export function parseBetaAcceptanceOptions(arguments_) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      action: { type: 'string' },
      'baseline-manifest': { type: 'string' },
      'candidate-manifest': {
        type: 'string',
        default: 'artifacts/release-manifest.json',
      },
      'compose-file': { type: 'string', default: 'infra/compose.production.yml' },
      'env-file': { type: 'string', default: 'infra/.env.production' },
      'public-url': { type: 'string' },
      state: { type: 'string', default: 'artifacts/beta-acceptance-state.json' },
      output: { type: 'string', default: 'artifacts/beta-acceptance.json' },
      port: { type: 'string', default: '3000' },
      'docker-gid': { type: 'string', default: '0' },
      'wait-seconds': { type: 'string', default: '180' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!['start', 'finish', 'cleanup'].includes(values.action)) {
    throw new Error('--action must be start, finish, or cleanup.');
  }
  if (values.action === 'start' && values['baseline-manifest'] === undefined) {
    throw new Error('--baseline-manifest is required when starting acceptance.');
  }
  if (values.action === 'start' && values['public-url'] === undefined) {
    throw new Error('--public-url is required when starting acceptance.');
  }
  if (!/^\d{1,10}$/.test(values['docker-gid'])) {
    throw new Error('--docker-gid must be a nonnegative integer.');
  }
  return {
    action: values.action,
    baselineManifestPath: values['baseline-manifest'] === undefined
      ? undefined
      : resolveRepositoryPath(values['baseline-manifest'], 'The baseline manifest'),
    candidateManifestPath: resolveRepositoryPath(
      values['candidate-manifest'],
      'The candidate manifest',
    ),
    composeFile: resolveRepositoryPath(values['compose-file'], 'The Compose file'),
    envFile: resolveRepositoryPath(values['env-file'], 'The environment file'),
    statePath: resolveRepositoryPath(values.state, 'The acceptance state file'),
    outputPath: resolveRepositoryPath(values.output, 'The acceptance report'),
    publicUrl: values['public-url'] === undefined
      ? undefined
      : parsePublicUrl(values['public-url']),
    port: parseInteger(values.port, '--port', 1_024, 65_535),
    dockerGid: values['docker-gid'],
    waitSeconds: parseInteger(values['wait-seconds'], '--wait-seconds', 30, 600),
  };
}

export function validateBetaReleasePair(baselineValue, candidateValue) {
  const baseline = parseReleaseManifest(baselineValue);
  const candidate = parseReleaseManifest(candidateValue);
  if (baseline.sourceTree !== 'clean' || candidate.sourceTree !== 'clean') {
    throw new Error('Beta acceptance requires clean release manifests.');
  }
  if (baseline.sourceRevision === candidate.sourceRevision) {
    throw new Error('Baseline and candidate revisions must be different.');
  }
  for (const service of Object.keys(serviceEnvironmentNames)) {
    const before = baseline.images.find((image) => image.service === service);
    const after = candidate.images.find((image) => image.service === service);
    if (before.digest === after.digest) {
      throw new Error(`${service} must have distinct baseline and candidate images.`);
    }
  }
  return { baseline, candidate };
}

export function createBetaIdentity(suffix) {
  if (!/^[a-f0-9]{12}$/.test(suffix)) {
    throw new Error('The beta acceptance suffix is invalid.');
  }
  const project = `walkz-beta-${suffix}`;
  return {
    project,
    postgresVolume: `${project}-postgres`,
    proofVolume: `${project}-proof`,
  };
}

export function createBetaEnvironment(
  manifest,
  state,
  environment = process.env,
) {
  const result = {
    ...environment,
    GITHUB_OAUTH_CALLBACK_URL: `${state.publicUrl}/auth/github/callback`,
    WALKZ_PUBLIC_URL: state.publicUrl,
    WALKZ_DOCKER_GID: state.dockerGid,
    WALKZ_HTTP_PORT: String(state.port),
    WALKZ_POSTGRES_VOLUME: state.postgresVolume,
    WALKZ_PROOF_VOLUME: state.proofVolume,
  };
  for (const [service, name] of Object.entries(serviceEnvironmentNames)) {
    result[name] = manifest.images.find((image) => image.service === service).digest;
  }
  return result;
}

function runCommand(command, arguments_, options = {}) {
  try {
    return execFileSync(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      encoding: 'utf8',
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 4 * 1_024 * 1_024,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1_000,
    });
  } catch {
    throw new Error(`${options.label ?? command} failed.`);
  }
}

function createAdapter(state, run = runCommand) {
  const composeArguments = (arguments_) => [
    'compose',
    '--project-name', state.project,
    '--env-file', state.envFile,
    '--file', state.composeFile,
    ...arguments_,
  ];
  return {
    docker(arguments_, settings = {}) {
      return run('docker', arguments_, settings);
    },
    compose(arguments_, environment, settings = {}) {
      return run('docker', composeArguments(arguments_), {
        ...settings,
        cwd: state.deploymentDirectory,
        env: environment,
      });
    },
    async fetch(url, settings = {}) {
      return fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        ...settings,
      });
    },
  };
}

function imageIdentity(adapter, image, environment) {
  const output = adapter.docker([
    'image', 'inspect', image.digest, '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.walkz.service"}}',
  ], { env: environment, label: `Inspect ${image.service} image` });
  const [revision, service] = output.trim().split('|');
  if (revision !== image.revision || service !== image.service) {
    throw new Error(`${image.service} image labels do not match its release manifest.`);
  }
}

function assertReleaseImages(adapter, manifest, environment) {
  for (const image of manifest.images) {
    imageIdentity(adapter, {
      ...image,
      revision: manifest.sourceRevision,
    }, environment);
  }
}

function inspectRunningRevision(adapter, environment, service, expectedRevision) {
  const container = adapter.compose(
    ['ps', '--quiet', service],
    environment,
    { label: `Locate ${service} container` },
  ).trim();
  if (container.length === 0) throw new Error(`${service} is not running.`);
  const revision = adapter.docker([
    'inspect', container, '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  ], { env: environment, label: `Inspect running ${service}` }).trim();
  if (revision !== expectedRevision) {
    throw new Error(`${service} is not running the expected source revision.`);
  }
}

function assertRunningRelease(adapter, manifest, environment) {
  for (const service of Object.keys(serviceEnvironmentNames)) {
    inspectRunningRevision(adapter, environment, service, manifest.sourceRevision);
  }
}

function assertProjectRemoved(adapter, state, environment) {
  const containers = adapter.docker([
    'ps', '--all', '--quiet', '--filter',
    `label=com.docker.compose.project=${state.project}`,
  ], { env: environment, label: 'Check beta containers' }).trim();
  const networks = adapter.docker([
    'network', 'ls', '--quiet', '--filter',
    `label=com.docker.compose.project=${state.project}`,
  ], { env: environment, label: 'Check beta networks' }).trim();
  const volumes = adapter.docker([
    'volume', 'ls', '--quiet', '--filter', `name=^${state.project}-`,
  ], { env: environment, label: 'Check beta volumes' }).trim();
  if (containers.length > 0 || networks.length > 0 || volumes.length > 0) {
    throw new Error('Beta acceptance cleanup left Docker resources behind.');
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadJson(path, description) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${description} could not be read.`);
  }
}

function validateDeploymentDirectory(path, project) {
  const root = resolve(tmpdir());
  const directory = resolve(path);
  const child = relative(root, directory);
  if (
    child.startsWith('..') ||
    isAbsolute(child) ||
    basename(directory) !== project ||
    !projectPattern.test(project)
  ) {
    throw new Error('The beta deployment directory is outside its safe temporary root.');
  }
  return directory;
}

export function parseBetaState(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The beta acceptance state is invalid.');
  }
  const state = value;
  if (
    state.schemaVersion !== stateSchemaVersion ||
    state.status !== 'awaiting_manual' ||
    !projectPattern.test(state.project ?? '') ||
    typeof state.envFile !== 'string' ||
    typeof state.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(state.startedAt)) ||
    typeof state.composeSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.composeSha256) ||
    typeof state.publicUrl !== 'string' ||
    typeof state.dockerGid !== 'string' ||
    !/^\d{1,10}$/.test(state.dockerGid) ||
    !Number.isInteger(state.port) ||
    state.port < 1_024 ||
    state.port > 65_535 ||
    state.postgresVolume !== `${state.project}-postgres` ||
    state.proofVolume !== `${state.project}-proof`
  ) {
    throw new Error('The beta acceptance state is invalid.');
  }
  const publicUrl = parsePublicUrl(state.publicUrl);
  const envFile = resolveRepositoryPath(
    state.envFile,
    'The beta environment file',
  );
  const deploymentDirectory = validateDeploymentDirectory(
    state.deploymentDirectory,
    state.project,
  );
  const releases = validateBetaReleasePair(state.baseline, state.candidate);
  return {
    schemaVersion: stateSchemaVersion,
    status: 'awaiting_manual',
    project: state.project,
    envFile,
    deploymentDirectory,
    composeFile: resolve(deploymentDirectory, 'compose.production.yml'),
    composeSha256: state.composeSha256,
    startedAt: new Date(state.startedAt).toISOString(),
    publicUrl,
    localUrl: `http://127.0.0.1:${state.port}`,
    port: state.port,
    dockerGid: state.dockerGid,
    postgresVolume: state.postgresVolume,
    proofVolume: state.proofVolume,
    ...releases,
  };
}

function psqlJson(adapter, environment, sql, label) {
  const output = adapter.compose([
    'exec', '--no-TTY', 'postgres',
    'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--tuples-only',
    '--no-align', '--username=walkz', '--dbname=walkz', '--command', sql,
  ], environment, { label }).trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function acceptanceObservation(adapter, environment, startedAt) {
  const timestamp = new Date(startedAt).toISOString();
  return psqlJson(adapter, environment, `
WITH eligible_reviews AS (
  SELECT id
  FROM review_runs
  WHERE created_at >= '${timestamp}'::timestamptz
), stable AS (
  SELECT jsonb_build_object(
    'users', (SELECT count(*) FROM users),
    'activeSessions', (
      SELECT count(*) FROM sessions
      WHERE expires_at > now() AND revoked_at IS NULL
    ),
    'installations', (SELECT count(*) FROM github_installations),
    'repositories', (SELECT count(*) FROM repositories),
    'fixReviews', (
      SELECT count(*) FROM review_runs rr
      JOIN eligible_reviews er ON er.id = rr.id
      WHERE rr.verdict = 'FIX'
    ),
    'verifiedFindings', (
      SELECT count(*) FROM findings f
      JOIN eligible_reviews er ON er.id = f.review_run_id
      WHERE f.evidence_level = 'VERIFIED'
    ),
    'approvedSuggestions', (
      SELECT count(*) FROM patch_proposals pp
      JOIN eligible_reviews er ON er.id = pp.review_run_id
      WHERE pp.approval_status = 'approved'
        AND pp.github_reference_kind = 'review_comment'
        AND pp.github_reference IS NOT NULL
    ),
    'resolvedReproofs', (
      SELECT count(*) FROM evidence e
      JOIN eligible_reviews er ON er.id = e.review_run_id
      WHERE e.evidence_kind = 'patch_reproof'
        AND e.reproof_outcome = 'resolved'
    ),
    'outboxTotal', (SELECT count(*) FROM outbox_events),
    'outboxPublished', (
      SELECT count(*) FROM outbox_events WHERE published_at IS NOT NULL
    ),
    'suggestionDigest', COALESCE((
      SELECT encode(digest(string_agg(pp.github_reference, ',' ORDER BY pp.id), 'sha256'), 'hex')
      FROM patch_proposals pp
      JOIN eligible_reviews er ON er.id = pp.review_run_id
      WHERE pp.github_reference IS NOT NULL
    ), encode(digest('', 'sha256'), 'hex'))
  ) AS value
)
SELECT value::text FROM stable;
`, 'Inspect beta journey');
}

function numericCount(observation, name) {
  const value = Number(observation[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${name} acceptance count is invalid.`);
  }
  return value;
}

export function validateManualJourney(observation) {
  const requirements = {
    users: 'GitHub sign-in',
    activeSessions: 'an active GitHub session',
    installations: 'GitHub App installation discovery',
    repositories: 'repository selection',
    fixReviews: 'a FIX review created during this run',
    verifiedFindings: 'a VERIFIED finding',
    approvedSuggestions: 'an approved GitHub suggestion',
    resolvedReproofs: 'a resolved patch reproof',
  };
  const missing = [];
  for (const [name, description] of Object.entries(requirements)) {
    if (numericCount(observation, name) < 1) missing.push(description);
  }
  if (!/^[a-f0-9]{64}$/.test(observation.suggestionDigest ?? '')) {
    throw new Error('The suggestion acceptance digest is invalid.');
  }
  numericCount(observation, 'outboxTotal');
  numericCount(observation, 'outboxPublished');
  if (missing.length > 0) {
    throw new Error(`Manual beta journey is incomplete: ${missing.join(', ')}.`);
  }
  return observation;
}

function stableJourneyDigest(observation) {
  return digest(JSON.stringify({
    users: numericCount(observation, 'users'),
    installations: numericCount(observation, 'installations'),
    repositories: numericCount(observation, 'repositories'),
    fixReviews: numericCount(observation, 'fixReviews'),
    verifiedFindings: numericCount(observation, 'verifiedFindings'),
    approvedSuggestions: numericCount(observation, 'approvedSuggestions'),
    resolvedReproofs: numericCount(observation, 'resolvedReproofs'),
    outboxTotal: numericCount(observation, 'outboxTotal'),
    outboxPublished: numericCount(observation, 'outboxPublished'),
    suggestionDigest: observation.suggestionDigest,
  }));
}

async function assertWebAndOAuth(adapter, state) {
  const home = await adapter.fetch(state.localUrl);
  if (!home.ok) throw new Error('The beta dashboard is unavailable.');
  const oauth = await adapter.fetch(`${state.localUrl}/auth/github/start`);
  const location = oauth.headers.get('location');
  if (
    oauth.status < 300 ||
    oauth.status >= 400 ||
    location === null ||
    new URL(location).origin !== 'https://github.com' ||
    new URL(location).pathname !== '/login/oauth/authorize'
  ) {
    throw new Error('The beta GitHub sign-in route is invalid.');
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function cleanupState(options, state, adapter, environment) {
  const composeSource = await readFile(state.composeFile, 'utf8');
  if (digest(composeSource) !== state.composeSha256) {
    throw new Error('The clean beta Compose bundle changed before cleanup.');
  }
  let cleanupError;
  try {
    adapter.compose(
      ['down', '--volumes', '--remove-orphans', '--timeout', '30'],
      environment,
      { label: 'Remove beta acceptance resources' },
    );
    assertProjectRemoved(adapter, state, environment);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  await rm(state.deploymentDirectory, { recursive: true, force: true });
  await rm(options.statePath, { force: true });
}

export async function startBetaAcceptance(options, dependencies = {}) {
  let stateExists = true;
  try {
    await readFile(options.statePath, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      stateExists = false;
    } else {
      throw new Error('The beta acceptance state could not be checked.');
    }
  }
  if (stateExists) throw new Error('An unfinished beta acceptance state already exists.');
  const [baselineValue, candidateValue, composeSource] = await Promise.all([
    dependencies.baseline ?? loadJson(options.baselineManifestPath, 'The baseline manifest'),
    dependencies.candidate ?? loadJson(options.candidateManifestPath, 'The candidate manifest'),
    dependencies.composeSource ?? readFile(options.composeFile, 'utf8'),
  ]);
  const releases = validateBetaReleasePair(baselineValue, candidateValue);
  const identity = createBetaIdentity(
    dependencies.suffix ?? randomBytes(6).toString('hex'),
  );
  const deploymentDirectory = dependencies.deploymentDirectory ??
    resolve(tmpdir(), identity.project);
  if (dependencies.deploymentDirectory === undefined) {
    await mkdir(deploymentDirectory, { recursive: false });
  }
  const composeFile = resolve(deploymentDirectory, 'compose.production.yml');
  const state = parseBetaState({
    schemaVersion: stateSchemaVersion,
    status: 'awaiting_manual',
    ...identity,
    envFile: options.envFile,
    deploymentDirectory,
    composeSha256: digest(composeSource),
    startedAt: new Date(dependencies.now ?? Date.now()).toISOString(),
    publicUrl: options.publicUrl,
    port: options.port,
    dockerGid: options.dockerGid,
    baseline: releases.baseline,
    candidate: releases.candidate,
  });
  const environment = createBetaEnvironment(
    state.candidate,
    state,
    dependencies.environment,
  );
  const adapter = dependencies.adapter ?? createAdapter(state);
  let stateWritten = false;
  try {
    await writeFile(composeFile, composeSource, { encoding: 'utf8', flag: 'wx' });
    await writeFile(
      resolve(deploymentDirectory, 'release-manifest.baseline.json'),
      `${JSON.stringify(state.baseline, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await writeFile(
      resolve(deploymentDirectory, 'release-manifest.candidate.json'),
      `${JSON.stringify(state.candidate, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await writeState(options.statePath, state);
    stateWritten = true;
    assertReleaseImages(adapter, state.baseline, environment);
    assertReleaseImages(adapter, state.candidate, environment);
    adapter.compose(['config', '--quiet'], environment, {
      label: 'Validate clean beta bundle',
    });
    const existing = adapter.docker([
      'ps', '--all', '--quiet', '--filter',
      `label=com.docker.compose.project=${state.project}`,
    ], { env: environment, label: 'Check beta project isolation' }).trim();
    if (existing.length > 0) throw new Error('The beta acceptance project already exists.');
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'postgres', 'redis',
    ], environment, { label: 'Start clean beta data services' });
    adapter.compose(['run', '--rm', '--no-deps', 'migrate'], environment, {
      label: 'Migrate clean beta database',
    });
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'api', 'worker', 'web',
    ], environment, { label: 'Start clean beta application' });
    assertRunningRelease(adapter, state.candidate, environment);
    await assertWebAndOAuth(adapter, state);
    return state;
  } catch (operationError) {
    try {
      adapter.compose(
        ['down', '--volumes', '--remove-orphans', '--timeout', '30'],
        environment,
        { label: 'Clean failed beta start' },
      );
      assertProjectRemoved(adapter, state, environment);
    } catch (cleanupError) {
      if (!stateWritten) {
        try {
          await writeState(options.statePath, state);
          stateWritten = true;
        } catch {}
      }
      throw new AggregateError(
        [operationError, cleanupError],
        'Beta acceptance startup failed and cleanup was incomplete.',
      );
    }
    await rm(deploymentDirectory, { recursive: true, force: true });
    if (stateWritten) await rm(options.statePath, { force: true });
    throw operationError;
  }
}

export async function finishBetaAcceptance(options, dependencies = {}) {
  const state = parseBetaState(
    dependencies.state ?? await loadJson(options.statePath, 'The acceptance state'),
  );
  const composeSource = await readFile(state.composeFile, 'utf8');
  if (digest(composeSource) !== state.composeSha256) {
    throw new Error('The clean beta Compose bundle changed after startup.');
  }
  const candidateEnvironment = createBetaEnvironment(
    state.candidate,
    state,
    dependencies.environment,
  );
  const baselineEnvironment = createBetaEnvironment(
    state.baseline,
    state,
    dependencies.environment,
  );
  const adapter = dependencies.adapter ?? createAdapter(state);
  const before = validateManualJourney(
    acceptanceObservation(adapter, candidateEnvironment, state.startedAt),
  );
  const beforeDigest = stableJourneyDigest(before);
  const startedAt = Date.now();
  let operationError;
  let report;
  try {
    assertRunningRelease(adapter, state.candidate, candidateEnvironment);
    adapter.compose(['stop', '--timeout', '30', 'api', 'worker', 'redis'], candidateEnvironment, {
      label: 'Stop beta services for restart recovery',
    });
    adapter.compose(['rm', '--force', 'redis'], candidateEnvironment, {
      label: 'Remove disposable beta queue',
    });
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      'redis',
    ], candidateEnvironment, { label: 'Start replacement beta queue' });
    const reconciliation = adapter.compose(
      ['run', '--rm', '--no-deps', 'reconcile'],
      candidateEnvironment,
      { label: 'Reconcile beta durable work' },
    );
    if (!/^Reconciled durable work: outbox=\d+, comment_commands=\d+, reviews=\d+, patch_fixes=\d+\.\s*$/.test(reconciliation)) {
      throw new Error('Beta durable reconciliation returned an invalid summary.');
    }
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      '--force-recreate', 'api', 'worker', 'web',
    ], candidateEnvironment, { label: 'Restart beta application' });
    assertRunningRelease(adapter, state.candidate, candidateEnvironment);
    await assertWebAndOAuth(adapter, state);
    const afterRestart = validateManualJourney(
      acceptanceObservation(adapter, candidateEnvironment, state.startedAt),
    );
    if (stableJourneyDigest(afterRestart) !== beforeDigest) {
      throw new Error('Restart recovery changed the completed beta journey.');
    }

    adapter.compose(['run', '--rm', '--no-deps', 'migrate'], baselineEnvironment, {
      label: 'Check beta rollback migration compatibility',
    });
    adapter.compose([
      'up', '--detach', '--wait', '--wait-timeout', String(options.waitSeconds),
      '--force-recreate', '--no-deps', 'api', 'worker', 'web',
    ], baselineEnvironment, { label: 'Roll back full beta application' });
    assertRunningRelease(adapter, state.baseline, baselineEnvironment);
    await assertWebAndOAuth(adapter, state);
    const afterRollback = validateManualJourney(
      acceptanceObservation(adapter, baselineEnvironment, state.startedAt),
    );
    if (stableJourneyDigest(afterRollback) !== beforeDigest) {
      throw new Error('Rollback changed the completed beta journey.');
    }
    report = {
      schemaVersion: 1,
      outcome: 'passed',
      baselineRevision: state.baseline.sourceRevision,
      candidateRevision: state.candidate.sourceRevision,
      finalRevision: state.baseline.sourceRevision,
      checks: {
        signIn: true,
        installation: true,
        fixReview: true,
        verifiedProof: true,
        approvedSuggestion: true,
        resolvedReproof: true,
        restartRecovery: true,
        rollback: true,
      },
      counts: {
        fixReviews: numericCount(before, 'fixReviews'),
        verifiedFindings: numericCount(before, 'verifiedFindings'),
        approvedSuggestions: numericCount(before, 'approvedSuggestions'),
        resolvedReproofs: numericCount(before, 'resolvedReproofs'),
      },
      bundleSha256: state.composeSha256,
      resourcesRetained: false,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await cleanupState(options, state, adapter, baselineEnvironment);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    throw new AggregateError(
      operationError === undefined ? [cleanupError] : [operationError, cleanupError],
      'Beta acceptance failed and cleanup was incomplete.',
    );
  }
  if (operationError !== undefined) throw operationError;
  if (report === undefined) throw new Error('Beta acceptance did not produce a report.');
  report.durationMs = Date.now() - startedAt;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function cleanupBetaAcceptance(options, dependencies = {}) {
  const state = parseBetaState(
    dependencies.state ?? await loadJson(options.statePath, 'The acceptance state'),
  );
  const environment = createBetaEnvironment(
    state.candidate,
    state,
    dependencies.environment,
  );
  const adapter = dependencies.adapter ?? createAdapter(state);
  await cleanupState(options, state, adapter, environment);
}

async function main() {
  try {
    const options = parseBetaAcceptanceOptions(process.argv.slice(2));
    if (options.action === 'start') {
      const state = await startBetaAcceptance(options);
      process.stdout.write(
        `Clean beta stack started at ${state.localUrl}. ` +
        `Set the GitHub App callback to ${state.publicUrl}/auth/github/callback ` +
        `and its webhook to ${state.publicUrl}/webhooks/github.\n`,
      );
      return;
    }
    if (options.action === 'finish') {
      const report = await finishBetaAcceptance(options);
      process.stdout.write(
        `Beta acceptance passed and rolled back to ${report.finalRevision.slice(0, 12)}. ` +
        'All disposable resources were removed.\n',
      );
      return;
    }
    await cleanupBetaAcceptance(options);
    process.stdout.write('Beta acceptance resources were removed.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Beta acceptance failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
