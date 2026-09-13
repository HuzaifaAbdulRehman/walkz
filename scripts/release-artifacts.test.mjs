import { describe, expect, it } from 'vitest';

import {
  createImageDefinitions,
  createReleaseManifest,
  selectForbiddenFirstPartyPaths,
  serializeReleaseManifest,
  verifyImageInspection,
} from './release-artifacts.mjs';

const revision = 'a'.repeat(40);
const version = '0.1.0';
const definition = createImageDefinitions(version, revision)[0];

function inspection(overrides = {}) {
  return {
    Id: `sha256:${'b'.repeat(64)}`,
    Created: '2023-11-14T22:13:20Z',
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      User: '1000:1000',
      Env: ['NODE_ENV=production'],
      Labels: {
        'io.walkz.service': definition.service,
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.source': 'https://github.com/HuzaifaAbdulRehman/walkz',
        'org.opencontainers.image.version': version,
      },
    },
    ...overrides,
  };
}

describe('release artifact contract', () => {
  it('separates first-party build inputs from installed dependencies', () => {
    expect(selectForbiddenFirstPartyPaths([
      '/workspace/.env',
      '/workspace/apps/api/private.pem',
      '/workspace/node_modules/bottleneck/.env',
    ])).toEqual([
      '/workspace/.env',
      '/workspace/apps/api/private.pem',
    ]);
  });

  it('creates stable image references for every runtime service', () => {
    expect(createImageDefinitions(version, revision)).toEqual([
      { service: 'api', target: 'api', reference: `walkz-api:0.1.0-${'a'.repeat(12)}` },
      { service: 'web', target: 'web', reference: `walkz-web:0.1.0-${'a'.repeat(12)}` },
      { service: 'worker', target: 'worker', reference: `walkz-worker:0.1.0-${'a'.repeat(12)}` },
    ]);
  });

  it('accepts an exact revision, non-root user, and clean runtime filesystem', () => {
    expect(verifyImageInspection({
      definition,
      inspection: inspection(),
      runtimeIdentity: { gid: 1000, uid: 1000 },
      revision,
      sourceDateEpoch: '1700000000',
      version,
    })).toEqual({
      service: 'api',
      target: 'api',
      reference: definition.reference,
      digest: `sha256:${'b'.repeat(64)}`,
      platform: 'linux/amd64',
      user: '1000:1000',
    });
  });

  it('rejects root images and persisted credential inputs', () => {
    const unsafe = inspection();
    unsafe.Config = {
      ...unsafe.Config,
      User: 'root',
      Env: ['GROQ_API_KEY=gsk_example_value'],
    };
    expect(() => verifyImageInspection({
      definition,
      inspection: unsafe,
      leakedPaths: ['/workspace/.env'],
      history: 'GITHUB_CLIENT_SECRET=example',
      runtimeIdentity: { gid: 0, uid: 0 },
      revision,
      sourceDateEpoch: '1700000000',
      version,
    })).toThrow(/configured user.*sensitive environment.*history.*forbidden files/);
  });

  it('serializes the manifest without time-dependent metadata', () => {
    const image = verifyImageInspection({
      definition,
      inspection: inspection(),
      runtimeIdentity: { gid: 1000, uid: 1000 },
      revision,
      sourceDateEpoch: '1700000000',
      version,
    });
    const images = createImageDefinitions(version, revision).map((candidate) => ({
      ...image,
      service: candidate.service,
      target: candidate.target,
      reference: candidate.reference,
    }));
    const manifest = createReleaseManifest({
      version,
      revision,
      sourceDateEpoch: '1700000000',
      sourceTree: 'clean',
      images,
    });
    expect(serializeReleaseManifest(manifest)).toBe(serializeReleaseManifest(manifest));
    expect(manifest.images.map(({ service }) => service)).toEqual(['api', 'web', 'worker']);
    expect(manifest).not.toHaveProperty('createdAt');
  });

  it('rejects a container that actually starts as root', () => {
    expect(() => verifyImageInspection({
      definition,
      inspection: inspection(),
      runtimeIdentity: { gid: 0, uid: 0 },
      revision,
      sourceDateEpoch: '1700000000',
      version,
    })).toThrow(/runtime identity/);
  });
});
