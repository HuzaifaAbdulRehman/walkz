import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAcceptanceFixtureConfig,
  createBetaEnvironment,
  createBetaIdentity,
  finishBetaAcceptance,
  parseBetaAcceptanceOptions,
  parseBetaState,
  prepareBetaAcceptance,
  startBetaAcceptance,
  validateBetaReleasePair,
  validateManualJourney,
} from './beta-acceptance.mjs';

const temporaryDirectories = [];
const baselineRevision = 'a'.repeat(40);
const candidateRevision = 'b'.repeat(40);

function manifest(revision, digestCharacter) {
  return {
    schemaVersion: 1,
    version: '0.1.0',
    source: 'https://github.com/HuzaifaAbdulRehman/walkz',
    sourceRevision: revision,
    sourceDateEpoch: 1700000000,
    sourceTree: 'clean',
    images: ['api', 'web', 'worker'].map((service, index) => ({
      service,
      target: service,
      reference: `walkz-${service}:0.1.0-test`,
      digest: `sha256:${String.fromCharCode(digestCharacter.charCodeAt(0) + index).repeat(64)}`,
      platform: 'linux/amd64',
      user: '1000:1000',
    })),
  };
}

function options(overrides = {}) {
  return {
    action: 'start',
    baselineManifestPath: 'unused',
    candidateManifestPath: 'unused',
    composeFile: 'unused',
    envFile: resolve('infra', '.env'),
    statePath: 'unused',
    outputPath: 'unused',
    publicUrl: 'https://walkz.example',
    port: 3000,
    dockerGid: '0',
    waitSeconds: 180,
    ...overrides,
  };
}

function state(directory) {
  const identity = createBetaIdentity('12345678abcd');
  return {
    schemaVersion: 2,
    status: 'awaiting_manual',
    ...identity,
    envFile: resolve('infra', '.env'),
    deploymentDirectory: directory,
    composeSha256: '1'.repeat(64),
    startedAt: '2026-09-14T00:00:00.000Z',
    publicUrl: 'https://walkz.example',
    port: 3000,
    dockerGid: '0',
    baseline: manifest(baselineRevision, '1'),
    candidate: manifest(candidateRevision, '4'),
  };
}

function completeObservation() {
  return {
    users: 1,
    activeSessions: 1,
    installations: 1,
    repositories: 1,
    fixReviews: 1,
    verifiedFindings: 1,
    approvedSuggestions: 1,
    resolvedReproofs: 1,
    outboxTotal: 4,
    outboxPublished: 4,
    suggestionDigest: 'a'.repeat(64),
  };
}

function defaultRepositoryConfig() {
  return {
    schemaVersion: 1,
    baseBranch: null,
    paths: {
      include: ['**/*'],
      exclude: ['.git/**', 'coverage/**', 'dist/**', 'node_modules/**'],
    },
    commands: [],
    commandTimeoutMs: 120_000,
    commandOutputBytesPerStream: 262_144,
    diffBudgetBytes: 524_288,
    fileBudget: 100,
    tokenBudget: 16_000,
    provider: { name: 'groq', model: 'auto' },
    triggerPolicy: 'manual',
    blockingEvidenceLevels: ['VERIFIED'],
    policyPacks: ['security-core@1', 'supply-chain@1', 'delivery-safety@1'],
    commandApprovalPolicy: 'prompt',
    premiumEnabled: false,
    spendingLimitUsd: 0,
  };
}

async function betaDirectory() {
  const parent = await mkdtemp(resolve(tmpdir(), 'walkz-beta-test-'));
  temporaryDirectories.push(parent);
  const directory = resolve(parent, 'walkz-beta-12345678abcd');
  await mkdir(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('clean-host beta acceptance contract', () => {
  it('requires explicit start inputs and contains repository paths', () => {
    expect(() => parseBetaAcceptanceOptions([])).toThrow(/action/);
    expect(() => parseBetaAcceptanceOptions([
      '--action', 'start', '--public-url', 'https://walkz.example',
    ])).toThrow(/baseline-manifest/);
    expect(() => parseBetaAcceptanceOptions([
      '--action', 'start', '--baseline-manifest', 'artifacts/baseline.json',
      '--public-url', 'http://walkz.example',
    ])).toThrow(/HTTPS origin/);
    expect(() => parseBetaAcceptanceOptions([
      '--action', 'cleanup', '--state', '../outside.json',
    ])).toThrow(/inside the repository/);
    expect(parseBetaAcceptanceOptions([
      '--action', 'prepare',
    ])).toMatchObject({ action: 'prepare' });
  });

  it('creates one immutable acceptance-only fixture command', () => {
    const prepared = createAcceptanceFixtureConfig(defaultRepositoryConfig());
    expect(prepared.config).toMatchObject({
      commandApprovalPolicy: 'trusted_config',
      commands: [{
        id: 'acceptance-discount',
        executable: 'node',
        cwd: '.',
        required: true,
      }],
      premiumEnabled: false,
      spendingLimitUsd: 0,
    });
    expect(prepared.config.commands[0].args.join(' ')).toContain(
      'fixtures/live/discount.mjs:2',
    );
    expect(prepared.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.alreadyPrepared).toBe(false);
    expect(createAcceptanceFixtureConfig({
      commandApprovalPolicy: prepared.config.commandApprovalPolicy,
      ...prepared.config,
      commands: [{
        required: true,
        cwd: '.',
        args: [...prepared.config.commands[0].args],
        executable: 'node',
        id: 'acceptance-discount',
      }],
    })).toMatchObject({ alreadyPrepared: true });
    expect(() => createAcceptanceFixtureConfig({
      ...defaultRepositoryConfig(),
      commands: [{ id: 'existing' }],
    })).toThrow(/empty command set/);
  });

  it('binds unique resources, public URLs, and immutable images', () => {
    const identity = createBetaIdentity('12345678abcd');
    const betaState = {
      ...identity,
      publicUrl: 'https://walkz.example',
      port: 3100,
      dockerGid: '7',
    };
    expect(createBetaEnvironment(
      manifest(candidateRevision, '4'),
      betaState,
      { SAFE_VALUE: 'kept' },
    )).toMatchObject({
      SAFE_VALUE: 'kept',
      GITHUB_OAUTH_CALLBACK_URL: 'https://walkz.example/auth/github/callback',
      WALKZ_PUBLIC_URL: 'https://walkz.example',
      WALKZ_HTTP_PORT: '3100',
      WALKZ_DOCKER_GID: '7',
      WALKZ_POSTGRES_VOLUME: 'walkz-beta-12345678abcd-postgres',
      WALKZ_PROOF_VOLUME: 'walkz-beta-12345678abcd-proof',
      WALKZ_API_IMAGE: `sha256:${'4'.repeat(64)}`,
      WALKZ_WEB_IMAGE: `sha256:${'5'.repeat(64)}`,
      WALKZ_WORKER_IMAGE: `sha256:${'6'.repeat(64)}`,
    });
    expect(() => createBetaIdentity('../unsafe')).toThrow(/suffix is invalid/);
  });

  it('requires distinct clean releases', () => {
    expect(validateBetaReleasePair(
      manifest(baselineRevision, '1'),
      manifest(candidateRevision, '4'),
    )).toMatchObject({
      baseline: { sourceRevision: baselineRevision },
      candidate: { sourceRevision: candidateRevision },
    });
    expect(() => validateBetaReleasePair(
      manifest(baselineRevision, '1'),
      manifest(baselineRevision, '4'),
    )).toThrow(/revisions must be different/);
  });

  it('rejects unsafe state and incomplete manual journeys', async () => {
    const directory = await betaDirectory();
    const valid = { ...state(directory), project: directory.split(/[\\/]/).at(-1) };
    valid.postgresVolume = `${valid.project}-postgres`;
    valid.proofVolume = `${valid.project}-proof`;
    expect(parseBetaState(valid)).toMatchObject({
      project: valid.project,
      envFile: resolve('infra', '.env'),
    });
    expect(() => parseBetaState({
      ...valid,
      deploymentDirectory: resolve('artifacts', valid.project),
    })).toThrow(/safe temporary root/);
    expect(() => validateManualJourney({
      ...completeObservation(),
      resolvedReproofs: 0,
    })).toThrow(/resolved patch reproof/);
  });

  it('cleans a failed start without retaining state', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const cleanupCalls = [];
    const adapter = {
      docker(arguments_) {
        if (arguments_[0] === 'image') {
          const image = [...manifest(baselineRevision, '1').images,
            ...manifest(candidateRevision, '4').images]
            .find((candidate) => candidate.digest === arguments_[2]);
          const revision = image.digest[7] < '4' ? baselineRevision : candidateRevision;
          return `${revision}|${image.service}`;
        }
        return '';
      },
      compose(arguments_) {
        cleanupCalls.push(arguments_);
        if (arguments_[0] === 'config') throw new Error('simulated failure');
        return '';
      },
      fetch() {
        throw new Error('not reached');
      },
    };
    const statePath = resolve(directory, '..', `${project}-state.json`);
    temporaryDirectories.push(statePath);
    await expect(startBetaAcceptance(options({ statePath }), {
      adapter,
      baseline: manifest(baselineRevision, '1'),
      candidate: manifest(candidateRevision, '4'),
      composeSource: 'services: {}',
      deploymentDirectory: directory,
      environment: {},
      suffix: project.slice('walkz-beta-'.length),
    })).rejects.toThrow('simulated failure');
    expect(cleanupCalls.at(-1)?.[0]).toBe('down');
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains interruption state when startup cleanup fails', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const statePath = resolve(directory, '..', `${project}-state.json`);
    temporaryDirectories.push(statePath);
    const baseline = manifest(baselineRevision, '1');
    const candidate = manifest(candidateRevision, '4');
    const imageMap = new Map([
      ...baseline.images.map((image) => [image.digest, `${baselineRevision}|${image.service}`]),
      ...candidate.images.map((image) => [image.digest, `${candidateRevision}|${image.service}`]),
    ]);
    const adapter = {
      docker(arguments_) {
        if (arguments_[0] === 'image') return imageMap.get(arguments_[2]);
        return '';
      },
      compose(arguments_) {
        if (arguments_[0] === 'config') throw new Error('start failed');
        if (arguments_[0] === 'down') throw new Error('cleanup failed');
        return '';
      },
      fetch() {
        throw new Error('not reached');
      },
    };
    await expect(startBetaAcceptance(options({ statePath }), {
      adapter,
      baseline,
      candidate,
      composeSource: 'services: {}',
      deploymentDirectory: directory,
      environment: {},
      suffix: project.slice('walkz-beta-'.length),
    })).rejects.toThrow(/cleanup was incomplete/);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ project });
    expect(await readFile(resolve(directory, 'compose.production.yml'), 'utf8'))
      .toBe('services: {}');
  });

  it('starts only exact images from the temporary bundle', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const statePath = resolve(directory, '..', `${project}-state.json`);
    temporaryDirectories.push(statePath);
    const baseline = manifest(baselineRevision, '1');
    const candidate = manifest(candidateRevision, '4');
    const imageMap = new Map([
      ...baseline.images.map((image) => [image.digest, `${baselineRevision}|${image.service}`]),
      ...candidate.images.map((image) => [image.digest, `${candidateRevision}|${image.service}`]),
    ]);
    const composeCalls = [];
    const adapter = {
      docker(arguments_) {
        if (arguments_[0] === 'image') return imageMap.get(arguments_[2]);
        if (arguments_[0] === 'inspect') return candidateRevision;
        return '';
      },
      compose(arguments_) {
        composeCalls.push(arguments_);
        if (arguments_[0] === 'ps') return `${arguments_.at(-1)}-container\n`;
        return '';
      },
      async fetch(url) {
        if (url.endsWith('/auth/github/start')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/login/oauth/authorize?state=safe' },
          });
        }
        return new Response('ok');
      },
    };
    const started = await startBetaAcceptance(options({ statePath }), {
      adapter,
      baseline,
      candidate,
      composeSource: 'name: clean-beta\nservices: {}\n',
      deploymentDirectory: directory,
      environment: {},
      suffix: project.slice('walkz-beta-'.length),
    });
    expect(started).toMatchObject({
      project,
      status: 'awaiting_manual',
      candidate: { sourceRevision: candidateRevision },
    });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ project });
    expect(composeCalls.some((call) => call[0] === 'down')).toBe(false);
  });

  it('prepares only the selected Walkz repository', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const betaState = {
      ...state(directory),
      project,
      postgresVolume: `${project}-postgres`,
      proofVolume: `${project}-proof`,
    };
    const compose = 'name: clean-beta\nservices: {}\n';
    const { createHash } = await import('node:crypto');
    betaState.composeSha256 = createHash('sha256').update(compose).digest('hex');
    await writeFile(resolve(directory, 'compose.production.yml'), compose, 'utf8');
    let saved;
    const adapter = {
      docker() {
        return candidateRevision;
      },
      compose(arguments_) {
        if (arguments_[0] === 'ps') return `${arguments_.at(-1)}-container\n`;
        if (arguments_.includes('psql')) {
          expect(arguments_.at(-1)).toContain('SELECT config_hash, config');
          return JSON.stringify({
            count: 1,
            repository: {
              repositoryId: '11111111-1111-4111-8111-111111111111',
              owner: 'HuzaifaAbdulRehman',
              name: 'walkz',
              configHash: 'a'.repeat(64),
              config: defaultRepositoryConfig(),
            },
          });
        }
        return '';
      },
    };
    const result = await prepareBetaAcceptance(options({ action: 'prepare' }), {
      adapter,
      environment: {},
      state: betaState,
      saveConfig: async (repository, prepared) => {
        saved = { repository, prepared };
        return { configHash: prepared.configHash };
      },
    });
    expect(saved.prepared.config.commands).toHaveLength(1);
    expect(result).toMatchObject({
      repository: 'HuzaifaAbdulRehman/walkz',
      commandId: 'acceptance-discount',
      configHash: saved.prepared.configHash,
    });

    await expect(prepareBetaAcceptance(options({ action: 'prepare' }), {
      adapter,
      environment: {},
      state: betaState,
      loadRepository: async () => ({
        repositoryId: '11111111-1111-4111-8111-111111111111',
        owner: 'someone-else',
        name: 'walkz',
        configHash: 'a'.repeat(64),
        config: defaultRepositoryConfig(),
      }),
      saveConfig: async () => {
        throw new Error('not reached');
      },
    })).rejects.toThrow(/selected Walkz repository/);
  });

  it('does not insert an already-current fixture configuration again', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const betaState = {
      ...state(directory),
      project,
      postgresVolume: `${project}-postgres`,
      proofVolume: `${project}-proof`,
    };
    const compose = 'name: clean-beta\nservices: {}\n';
    const { createHash } = await import('node:crypto');
    betaState.composeSha256 = createHash('sha256').update(compose).digest('hex');
    await writeFile(resolve(directory, 'compose.production.yml'), compose, 'utf8');
    const prepared = createAcceptanceFixtureConfig(defaultRepositoryConfig());
    const storedHash = 'c'.repeat(64);
    const adapter = {
      docker() {
        return candidateRevision;
      },
      compose(arguments_) {
        if (arguments_[0] === 'ps') return `${arguments_.at(-1)}-container\n`;
        return '';
      },
    };
    const result = await prepareBetaAcceptance(options({ action: 'prepare' }), {
      adapter,
      environment: {},
      state: betaState,
      loadRepository: async () => ({
        repositoryId: '11111111-1111-4111-8111-111111111111',
        owner: 'HuzaifaAbdulRehman',
        name: 'walkz',
        configHash: storedHash,
        config: {
          commandApprovalPolicy: 'trusted_config',
          ...prepared.config,
          commands: [{
            required: true,
            cwd: '.',
            args: [...prepared.config.commands[0].args],
            executable: 'node',
            id: 'acceptance-discount',
          }],
        },
      }),
      saveConfig: async () => {
        throw new Error('an idempotent prepare must not insert');
      },
    });
    expect(result.configHash).toBe(storedHash);
  });

  it('restarts, rolls back, records metadata, and cleans', async () => {
    const directory = await betaDirectory();
    const project = directory.split(/[\\/]/).at(-1);
    const betaState = {
      ...state(directory),
      project,
      postgresVolume: `${project}-postgres`,
      proofVolume: `${project}-proof`,
      composeSha256: '',
    };
    const compose = 'name: clean-beta\nservices: {}\n';
    betaState.composeSha256 = await (async () => {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(compose).digest('hex');
    })();
    await writeFile(resolve(directory, 'compose.production.yml'), compose, 'utf8');
    const outputPath = resolve(directory, '..', `${project}-report.json`);
    const statePath = resolve(directory, '..', `${project}-state.json`);
    temporaryDirectories.push(outputPath, statePath);
    let cleaned = false;
    let runningRevision = candidateRevision;
    const imageMap = new Map([
      ...betaState.baseline.images.map((image) => [image.digest, `${baselineRevision}|${image.service}`]),
      ...betaState.candidate.images.map((image) => [image.digest, `${candidateRevision}|${image.service}`]),
    ]);
    const adapter = {
      docker(arguments_) {
        if (arguments_[0] === 'inspect') return runningRevision;
        if (arguments_[0] === 'image') return imageMap.get(arguments_[2]);
        return '';
      },
      compose(arguments_, environment) {
        const last = arguments_.at(-1);
        if (arguments_.includes('psql')) return JSON.stringify(completeObservation());
        if (arguments_.includes('reconcile')) {
          return 'Reconciled durable work: outbox=0, comment_commands=0, reviews=0, patch_fixes=0.\n';
        }
        if (arguments_[0] === 'up' && arguments_.includes('api')) {
          runningRevision = environment.WALKZ_API_IMAGE === betaState.baseline.images[0].digest
            ? baselineRevision
            : candidateRevision;
        }
        if (arguments_[0] === 'ps' && ['api', 'web', 'worker'].includes(last)) {
          return `${last}-container\n`;
        }
        if (arguments_[0] === 'down') cleaned = true;
        return '';
      },
      async fetch(url) {
        if (url.endsWith('/auth/github/start')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/login/oauth/authorize?state=safe' },
          });
        }
        return new Response('ok');
      },
    };
    const report = await finishBetaAcceptance(options({
      action: 'finish',
      statePath,
      outputPath,
    }), {
      adapter,
      environment: {},
      state: betaState,
    });
    expect(report).toMatchObject({
      outcome: 'passed',
      baselineRevision,
      candidateRevision,
      finalRevision: baselineRevision,
      checks: { signIn: true, restartRecovery: true, rollback: true },
      resourcesRetained: false,
    });
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(report);
    expect(JSON.stringify(report)).not.toContain('suggestionDigest');
    expect(cleaned).toBe(true);
  });
});
