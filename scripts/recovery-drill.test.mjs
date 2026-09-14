import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRecoveryIdentity,
  createReleaseEnvironment,
  parseRecoveryOptions,
  runRecoveryDrill,
  validateRecoveryPair,
} from './recovery-drill.mjs';

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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('recovery drill contract', () => {
  it('requires an explicit baseline and contains every path', () => {
    expect(() => parseRecoveryOptions([])).toThrow(/baseline-manifest is required/);
    expect(() => parseRecoveryOptions([
      '--baseline-manifest', '../outside.json',
    ])).toThrow(/inside the repository/);
    expect(() => parseRecoveryOptions([
      '--baseline-manifest', 'artifacts/baseline.json',
      '--wait-seconds', '10',
    ])).toThrow(/30 through 600/);
    expect(() => parseRecoveryOptions([
      '--baseline-manifest', 'artifacts/baseline.json',
      '--docker-gid', 'root',
    ])).toThrow(/nonnegative integer/);
  });

  it('requires different clean releases and images', () => {
    expect(validateRecoveryPair(
      manifest(baselineRevision, '1'),
      manifest(candidateRevision, '4'),
    )).toMatchObject({
      baseline: { sourceRevision: baselineRevision },
      candidate: { sourceRevision: candidateRevision },
    });
    expect(() => validateRecoveryPair(
      manifest(baselineRevision, '1'),
      manifest(baselineRevision, '4'),
    )).toThrow(/revisions must be different/);
    const dirty = manifest(candidateRevision, '4');
    dirty.sourceTree = 'dirty';
    expect(() => validateRecoveryPair(
      manifest(baselineRevision, '1'),
      dirty,
    )).toThrow(/clean release manifests/);
  });

  it('uses unique volumes and immutable manifest image IDs', () => {
    const identity = createRecoveryIdentity('12345678abcd');
    const environment = createReleaseEnvironment(
      manifest(candidateRevision, '4'),
      identity,
      { SAFE_VALUE: 'kept' },
    );
    expect(identity.project).toBe('walkz-recovery-12345678abcd');
    expect(environment).toMatchObject({
      SAFE_VALUE: 'kept',
      WALKZ_POSTGRES_VOLUME: 'walkz-recovery-12345678abcd-postgres',
      WALKZ_PROOF_VOLUME: 'walkz-recovery-12345678abcd-proof',
      WALKZ_DOCKER_GID: '0',
      WALKZ_API_IMAGE: `sha256:${'4'.repeat(64)}`,
      WALKZ_WEB_IMAGE: `sha256:${'5'.repeat(64)}`,
      WALKZ_WORKER_IMAGE: `sha256:${'6'.repeat(64)}`,
    });
    expect(() => createRecoveryIdentity('../unsafe')).toThrow(/suffix is invalid/);
  });

  it('always attempts scoped Compose cleanup after a failure', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'walkz-recovery-test-'));
    temporaryDirectories.push(directory);
    const cleanupCalls = [];
    const baseline = manifest(baselineRevision, '1');
    const candidate = manifest(candidateRevision, '4');
    const revisions = new Map([
      ...baseline.images.map((image) => [image.digest, `${baselineRevision}|${image.service}`]),
      ...candidate.images.map((image) => [image.digest, `${candidateRevision}|${image.service}`]),
    ]);
    const adapter = {
      projectChecks: 0,
      docker(arguments_) {
        if (arguments_[0] === 'image') return revisions.get(arguments_[2]);
        if (arguments_[0] === 'ps' && this.projectChecks++ === 0) {
          throw new Error('simulated Docker failure');
        }
        return '';
      },
      compose(arguments_) {
        cleanupCalls.push(arguments_);
        return '';
      },
    };

    await expect(runRecoveryDrill({
      baselineManifestPath: 'unused',
      candidateManifestPath: 'unused',
      composeFile: 'unused',
      envFile: 'unused',
      outputPath: resolve(directory, 'report.json'),
      dockerGid: '0',
      waitSeconds: 180,
    }, {
      adapter,
      baseline,
      candidate,
      environment: {},
      suffix: '12345678abcd',
    })).rejects.toThrow('simulated Docker failure');
    expect(cleanupCalls.at(-1)).toEqual([
      'down', '--volumes', '--remove-orphans', '--timeout', '30',
    ]);
  });

  it('restores, reconciles, rolls back, and records only metadata', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'walkz-recovery-test-'));
    temporaryDirectories.push(directory);
    const baseline = manifest(baselineRevision, '1');
    const candidate = manifest(candidateRevision, '4');
    const imageIdentity = new Map([
      ...baseline.images.map((image) => [
        image.digest,
        `${baselineRevision}|${image.service}`,
      ]),
      ...candidate.images.map((image) => [
        image.digest,
        `${candidateRevision}|${image.service}`,
      ]),
    ]);
    const containerRevision = new Map();
    let reviewStatus = 'queued';
    let cleaned = false;
    const adapter = {
      docker(arguments_) {
        if (arguments_[0] === 'image') return imageIdentity.get(arguments_[2]);
        if (arguments_[0] === 'inspect') return containerRevision.get(arguments_[1]);
        if (arguments_[0] === 'volume') return cleaned ? '' : 'unrelated-volume\n';
        return '';
      },
      compose(arguments_, environment, settings = {}) {
        if (arguments_.includes('pg_dump')) return Buffer.from('safe custom archive');
        if (arguments_.includes('pg_restore') && arguments_.includes('--list')) {
          return 'TABLE DATA public review_runs walkz\n';
        }
        if (arguments_.includes('reconcile')) {
          return 'Reconciled durable work: outbox=0, comment_commands=0, reviews=1, patch_fixes=0.\n';
        }
        if (arguments_.includes('redis-cli')) return '1\n';
        const command = arguments_.at(-1);
        if (typeof command === 'string' && command.includes('SELECT count(*)')) return '20\n';
        if (typeof command === 'string' && command.includes('SELECT id ||')) {
          return `70000000-0000-4000-8000-000000000074|${reviewStatus}|phase-7.4-known-review\n`;
        }
        if (typeof command === 'string' && command.includes("status = 'cancelled'")) {
          reviewStatus = 'cancelled';
        }
        if (arguments_[0] === 'up' && arguments_.includes('api')) {
          const revision = environment.WALKZ_API_IMAGE === baseline.images[0].digest
            ? baselineRevision
            : candidateRevision;
          containerRevision.set('api-container', revision);
          containerRevision.set('worker-container', revision);
        }
        if (arguments_[0] === 'ps' && arguments_.includes('--quiet')) {
          return arguments_.at(-1) === 'api' ? 'api-container\n' : 'worker-container\n';
        }
        if (arguments_[0] === 'down') cleaned = true;
        return settings.encoding === null ? Buffer.alloc(0) : '';
      },
    };
    const outputPath = resolve(directory, 'nested', 'report.json');

    const report = await runRecoveryDrill({
      baselineManifestPath: 'unused',
      candidateManifestPath: 'unused',
      composeFile: 'unused',
      envFile: 'unused',
      outputPath,
      dockerGid: '0',
      waitSeconds: 180,
    }, {
      adapter,
      baseline,
      candidate,
      environment: {},
      suffix: '12345678abcd',
    });

    expect(report).toMatchObject({
      outcome: 'passed',
      baselineRevision,
      candidateRevision,
      knownReviewId: '70000000-0000-4000-8000-000000000074',
      backup: { retained: false },
      queueRecovery: { reviews: 1 },
      finalRevision: baselineRevision,
    });
    const stored = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(stored).toEqual(report);
    expect(JSON.stringify(stored)).not.toContain('safe custom archive');
    expect(cleaned).toBe(true);
  });
});
