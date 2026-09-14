import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const serviceNames = ['postgres', 'redis', 'migrate', 'api', 'worker', 'web'];
const hardenedServices = ['migrate', 'api', 'worker', 'web'];
const placeholderPattern = /(?:change[-_ ]?me|example|replace|placeholder)/i;
const immutableImagePattern = /^(?:sha256:[0-9a-f]{64}|[^\s@]+@sha256:[0-9a-f]{64})$/i;

export function validateImmutableImageReference(reference) {
  if (typeof reference !== 'string' || !immutableImagePattern.test(reference)) {
    throw new Error('Expected an immutable image ID or registry digest.');
  }
  return reference;
}

function networkNames(service) {
  if (Array.isArray(service?.networks)) return service.networks;
  return Object.keys(service?.networks ?? {});
}

function matchesNetworks(service, expected) {
  const actual = networkNames(service).toSorted();
  return actual.length === expected.length &&
    actual.every((network, index) => network === expected.toSorted()[index]);
}

function hasNoNewPrivileges(service) {
  return (service?.security_opt ?? []).some((value) =>
    /^no-new-privileges(?::|=)true$/.test(value));
}

function validateRequiredEnvironment(environment, requirements, failures) {
  for (const [name, minimumLength] of requirements) {
    const value = environment?.[name];
    if (
      typeof value !== 'string' ||
      value.length < minimumLength ||
      placeholderPattern.test(value)
    ) {
      failures.push(`${name} is missing, too short, or still a placeholder`);
    }
  }
}

function validateDatabaseUrl(value, serviceName, failures) {
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'postgres' ||
      url.username !== 'walkz' ||
      url.password.length < 12 ||
      placeholderPattern.test(url.password) ||
      url.pathname !== '/walkz'
    ) {
      throw new Error('invalid');
    }
  } catch {
    failures.push(`${serviceName} DATABASE_URL must use the internal PostgreSQL service and a non-placeholder password`);
  }
}

function validateCredentialKeys(environment, serviceName, failures) {
  const activeKeyId = environment?.WALKZ_CREDENTIAL_ACTIVE_KEY_ID;
  const value = environment?.WALKZ_CREDENTIAL_KEYS_JSON;
  try {
    const keys = JSON.parse(value);
    if (
      typeof activeKeyId !== 'string' ||
      activeKeyId.length === 0 ||
      placeholderPattern.test(activeKeyId) ||
      typeof keys !== 'object' ||
      keys === null ||
      Array.isArray(keys) ||
      typeof keys[activeKeyId] !== 'string' ||
      Buffer.from(keys[activeKeyId], 'base64').byteLength !== 32
    ) {
      throw new Error('invalid');
    }
  } catch {
    failures.push(`${serviceName} credential key set is invalid or still a placeholder`);
  }
}

function validatePublicUrls(apiEnvironment, workerEnvironment, failures) {
  try {
    const callback = new URL(apiEnvironment?.GITHUB_OAUTH_CALLBACK_URL);
    const publicUrl = new URL(workerEnvironment?.WALKZ_PUBLIC_URL);
    if (
      callback.protocol !== 'https:' ||
      callback.pathname !== '/auth/github/callback' ||
      callback.search.length > 0 ||
      callback.hash.length > 0 ||
      publicUrl.protocol !== 'https:' ||
      publicUrl.pathname !== '/' ||
      publicUrl.search.length > 0 ||
      publicUrl.hash.length > 0 ||
      callback.origin !== publicUrl.origin ||
      placeholderPattern.test(callback.hostname)
    ) {
      throw new Error('invalid');
    }
  } catch {
    failures.push('GitHub OAuth callback and WALKZ_PUBLIC_URL must share one public HTTPS origin');
  }
}

export function verifyProductionComposeModel(model) {
  const failures = [];
  const services = model?.services ?? {};

  for (const name of serviceNames) {
    if (services[name] === undefined) failures.push(`the ${name} service is missing`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Production Compose verification failed: ${[...new Set(failures)].join('; ')}.`,
    );
  }

  for (const name of serviceNames) {
    if (services[name].build !== undefined) {
      failures.push(`${name} must use prebuilt images`);
    }
    try {
      validateImmutableImageReference(services[name].image);
    } catch {
      failures.push(`${name} must use an immutable image ID or registry digest`);
    }
    if (name !== 'web' && (services[name].ports?.length ?? 0) > 0) {
      failures.push(`only web may publish a host port, but ${name} does`);
    }
  }

  if ((services.web.ports?.length ?? 0) !== 1) {
    failures.push('web must publish exactly one host port');
  }
  const workerExpose = services.worker.expose ?? [];
  if (!workerExpose.some((value) => String(value) === '3002')) {
    failures.push('worker must expose telemetry port 3002 only inside Compose');
  }
  const workerHealthTest = services.worker.healthcheck?.test ?? [];
  if (!workerHealthTest.some((value) => String(value).includes('/health/ready'))) {
    failures.push('worker must use its readiness endpoint for health checks');
  }
  if (model?.networks?.data?.internal !== true) {
    failures.push('the data network must be internal');
  }

  const expectedNetworks = {
    postgres: ['data'],
    redis: ['data'],
    migrate: ['data'],
    api: ['data', 'edge', 'egress'],
    worker: ['data', 'egress'],
    web: ['edge'],
  };
  for (const [name, expected] of Object.entries(expectedNetworks)) {
    if (!matchesNetworks(services[name], expected)) {
      failures.push(`${name} must use only the ${expected.join(', ')} network${expected.length === 1 ? '' : 's'}`);
    }
  }

  const postgresVolume = (services.postgres.volumes ?? []).find((volume) =>
    volume?.type === 'volume' && volume?.target === '/var/lib/postgresql/data');
  if (postgresVolume === undefined || typeof postgresVolume.source !== 'string') {
    failures.push('PostgreSQL data must use a named volume');
  }

  for (const name of hardenedServices) {
    const service = services[name];
    if (service.init !== true) failures.push(`${name} must enable the Compose init process`);
    if (service.user !== '1000:1000') failures.push(`${name} must run as 1000:1000`);
    if (service.read_only !== true) failures.push(`${name} must use a read-only root filesystem`);
    if (!(service.cap_drop ?? []).includes('ALL')) failures.push(`${name} must drop all Linux capabilities`);
    if (!hasNoNewPrivileges(service)) failures.push(`${name} must set no-new-privileges`);
  }

  if (services.migrate.image !== services.api.image) {
    failures.push('migrate must use the exact API image');
  }

  const apiEnvironment = services.api.environment ?? {};
  const workerEnvironment = services.worker.environment ?? {};
  if (
    workerEnvironment.WALKZ_TELEMETRY_HOST !== '0.0.0.0' ||
    String(workerEnvironment.WALKZ_TELEMETRY_PORT) !== '3002'
  ) {
    failures.push('worker telemetry must bind port 3002 on its internal network');
  }
  validateRequiredEnvironment(services.postgres.environment, [
    ['POSTGRES_PASSWORD', 12],
  ], failures);
  validateRequiredEnvironment(apiEnvironment, [
    ['GITHUB_APP_ID', 1],
    ['GITHUB_CLIENT_ID', 1],
    ['GITHUB_PRIVATE_KEY_BASE64', 32],
    ['GITHUB_CLIENT_SECRET', 1],
    ['GITHUB_WEBHOOK_SECRET', 32],
    ['WALKZ_OAUTH_STATE_SECRET', 32],
  ], failures);
  validateRequiredEnvironment(workerEnvironment, [
    ['GITHUB_APP_ID', 1],
    ['GITHUB_PRIVATE_KEY_BASE64', 32],
  ], failures);
  for (const name of ['migrate', 'api', 'worker']) {
    validateDatabaseUrl(services[name].environment?.DATABASE_URL, name, failures);
  }
  validateCredentialKeys(apiEnvironment, 'api', failures);
  validateCredentialKeys(workerEnvironment, 'worker', failures);
  validatePublicUrls(apiEnvironment, workerEnvironment, failures);

  if (failures.length > 0) {
    throw new Error(
      `Production Compose verification failed: ${[...new Set(failures)].join('; ')}.`,
    );
  }

  return {
    images: {
      api: services.api.image,
      web: services.web.image,
      worker: services.worker.image,
    },
    publishedService: 'web',
    postgresVolume: postgresVolume.source,
  };
}

export function renderProductionCompose({
  composeFile,
  envFile,
  run = execFileSync,
}) {
  let output;
  try {
    output = run('docker', [
      'compose',
      '--env-file', envFile,
      '--file', composeFile,
      'config',
      '--format', 'json',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1_024 * 1_024,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Docker Compose could not render the production configuration. Check the env file and required values.');
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Docker Compose returned an invalid production configuration.');
  }
}

async function main() {
  let values;
  try {
    values = parseArgs({
      options: {
        'compose-file': { type: 'string', default: 'infra/compose.production.yml' },
        'env-file': { type: 'string', default: 'infra/.env.production' },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const model = renderProductionCompose({
      composeFile: resolve(repositoryRoot, values['compose-file']),
      envFile: resolve(repositoryRoot, values['env-file']),
    });
    const result = verifyProductionComposeModel(model);
    process.stdout.write(
      `Verified production Compose: ${Object.keys(result.images).length} immutable app images, web-only host publishing, persistent PostgreSQL.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
