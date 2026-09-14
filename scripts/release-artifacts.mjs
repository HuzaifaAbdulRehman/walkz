const SOURCE_URL = 'https://github.com/HuzaifaAbdulRehman/walkz';
const REQUIRED_USER = '1000:1000';

const sensitiveEnvironmentName = /(?:^|_)(?:API_KEY|CLIENT_SECRET|CREDENTIALS?|PASSWORD|PRIVATE_KEY|TOKEN|WEBHOOK_SECRET)(?:$|_)/i;
const sensitiveHistoryValue = /(?:BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY|gsk_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|GROQ_API_KEY=|GITHUB_CLIENT_SECRET=|GITHUB_PRIVATE_KEY=|WALKZ_CREDENTIAL_KEYS_JSON=)/i;

export const releaseServices = Object.freeze([
  Object.freeze({ service: 'api', target: 'api' }),
  Object.freeze({ service: 'web', target: 'web' }),
  Object.freeze({ service: 'worker', target: 'worker' }),
]);

export function validateReleaseIdentity(version, revision, sourceDateEpoch) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('The source revision must be a full lowercase Git SHA.');
  }
  if (!/^(?:0|[1-9]\d*)$/.test(sourceDateEpoch)) {
    throw new Error('The source date epoch must be a non-negative integer.');
  }
}

export function createImageDefinitions(version, revision) {
  validateReleaseIdentity(version, revision, '0');
  const tag = `${version}-${revision.slice(0, 12)}`;
  return releaseServices.map(({ service, target }) => ({
    service,
    target,
    reference: `walkz-${service}:${tag}`,
  }));
}

export function selectForbiddenFirstPartyPaths(paths) {
  return paths.filter((path) => !path.startsWith('/workspace/node_modules/'));
}

export function verifyImageInspection({
  definition,
  inspection,
  leakedPaths = [],
  history = '',
  revision,
  runtimeIdentity,
  sourceDateEpoch,
  version,
}) {
  const failures = [];
  const labels = inspection?.Config?.Labels ?? {};
  const environment = inspection?.Config?.Env ?? [];

  if (!/^sha256:[0-9a-f]{64}$/.test(inspection?.Id ?? '')) {
    failures.push('the image ID is not a SHA-256 digest');
  }
  if (inspection?.Config?.User !== REQUIRED_USER) {
    failures.push(`the configured user is ${inspection?.Config?.User || 'unset'}`);
  }
  if (runtimeIdentity?.uid !== 1000 || runtimeIdentity?.gid !== 1000) {
    failures.push(
      `the runtime identity is ${runtimeIdentity?.uid ?? 'unknown'}:${runtimeIdentity?.gid ?? 'unknown'}`,
    );
  }
  if (Date.parse(inspection?.Created ?? '') !== Number(sourceDateEpoch) * 1_000) {
    failures.push('the image creation time does not match SOURCE_DATE_EPOCH');
  }
  if (labels['org.opencontainers.image.source'] !== SOURCE_URL) {
    failures.push('the source label is missing or incorrect');
  }
  if (labels['org.opencontainers.image.revision'] !== revision) {
    failures.push('the revision label does not match the release commit');
  }
  if (labels['org.opencontainers.image.version'] !== version) {
    failures.push('the version label does not match package.json');
  }
  if (labels['io.walkz.service'] !== definition.service) {
    failures.push('the service label does not match the image target');
  }

  const sensitiveNames = environment
    .map((entry) => entry.slice(0, Math.max(entry.indexOf('='), 0)))
    .filter((name) => sensitiveEnvironmentName.test(name));
  if (sensitiveNames.length > 0) {
    failures.push(`sensitive environment names are persisted: ${sensitiveNames.join(', ')}`);
  }
  if (sensitiveHistoryValue.test(history)) {
    failures.push('image history contains a credential-shaped value');
  }
  if (leakedPaths.length > 0) {
    failures.push(`forbidden files are present: ${leakedPaths.join(', ')}`);
  }

  if (failures.length > 0) {
    throw new Error(`${definition.service} image verification failed: ${failures.join('; ')}.`);
  }

  return {
    service: definition.service,
    target: definition.target,
    reference: definition.reference,
    digest: inspection.Id,
    platform: `${inspection.Os}/${inspection.Architecture}`,
    user: inspection.Config.User,
  };
}

export function createReleaseManifest({
  version,
  revision,
  sourceDateEpoch,
  sourceTree,
  images,
}) {
  validateReleaseIdentity(version, revision, sourceDateEpoch);
  if (!['clean', 'dirty'].includes(sourceTree)) {
    throw new Error('The source tree state must be clean or dirty.');
  }
  if (images.length !== releaseServices.length) {
    throw new Error('The release manifest must contain every runtime service.');
  }
  const orderedImages = releaseServices.map(({ service }) => {
    const image = images.find((candidate) => candidate.service === service);
    if (image === undefined) {
      throw new Error(`The release manifest is missing the ${service} image.`);
    }
    return image;
  });

  return {
    schemaVersion: 1,
    version,
    source: SOURCE_URL,
    sourceRevision: revision,
    sourceDateEpoch: Number(sourceDateEpoch),
    sourceTree,
    images: orderedImages,
  };
}

export function parseReleaseManifest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The release manifest must be an object.');
  }
  const manifest = value;
  validateReleaseIdentity(
    manifest.version,
    manifest.sourceRevision,
    String(manifest.sourceDateEpoch),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.source !== SOURCE_URL ||
    !['clean', 'dirty'].includes(manifest.sourceTree) ||
    !Array.isArray(manifest.images)
  ) {
    throw new Error('The release manifest metadata is invalid.');
  }

  const images = releaseServices.map((definition) => {
    const matches = manifest.images.filter((image) =>
      image?.service === definition.service);
    if (matches.length !== 1) {
      throw new Error(`The release manifest must contain one ${definition.service} image.`);
    }
    const image = matches[0];
    if (
      image.target !== definition.target ||
      typeof image.reference !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(image.digest ?? '') ||
      !/^[a-z0-9]+\/[a-z0-9]+$/.test(image.platform ?? '') ||
      image.user !== REQUIRED_USER
    ) {
      throw new Error(`The ${definition.service} release image is invalid.`);
    }
    return {
      service: image.service,
      target: image.target,
      reference: image.reference,
      digest: image.digest,
      platform: image.platform,
      user: image.user,
    };
  });
  if (manifest.images.length !== images.length) {
    throw new Error('The release manifest contains an unexpected image.');
  }

  return {
    schemaVersion: 1,
    version: manifest.version,
    source: SOURCE_URL,
    sourceRevision: manifest.sourceRevision,
    sourceDateEpoch: manifest.sourceDateEpoch,
    sourceTree: manifest.sourceTree,
    images,
  };
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
