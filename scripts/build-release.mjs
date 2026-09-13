import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  createImageDefinitions,
  createReleaseManifest,
  selectForbiddenFirstPartyPaths,
  serializeReleaseManifest,
  validateReleaseIdentity,
  verifyImageInspection,
} from './release-artifacts.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const defaultOutputPath = resolve(repositoryRoot, 'artifacts', 'release-manifest.json');
const forbiddenFileScan = String.raw`
const { readdir } = require('node:fs/promises');
const { basename, extname, join } = require('node:path');
const roots = ['/workspace'];
const forbiddenNames = new Set(['.env', '.git-credentials', '.npmrc']);
const forbiddenExtensions = new Set(['.key', '.p12', '.pfx', '.pem']);
const found = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && path !== '/workspace/node_modules') await walk(path);
    else if (entry.isFile() && (forbiddenNames.has(basename(path)) || forbiddenExtensions.has(extname(path).toLowerCase()))) found.push(path);
  }
}
(async () => {
  for (const root of roots) await walk(root);
  process.stdout.write(JSON.stringify({
    paths: found.sort(),
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  }));
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
`;

function run(command, arguments_, options = {}) {
  try {
    return execFileSync(command, arguments_, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error
      ? String(error.stderr).trim()
      : '';
    throw new Error(`${command} ${arguments_.join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
}

function readInspection(reference) {
  const parsed = JSON.parse(run('docker', ['image', 'inspect', reference]));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Docker returned an invalid inspection for ${reference}.`);
  }
  return parsed[0];
}

function inspectImageRuntime(reference) {
  const output = run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--entrypoint',
    'node',
    reference,
    '-e',
    forbiddenFileScan,
  ]);
  const parsed = JSON.parse(output);
  if (
    !Array.isArray(parsed.paths) ||
    parsed.paths.some((path) => typeof path !== 'string') ||
    !Number.isInteger(parsed.uid) ||
    !Number.isInteger(parsed.gid)
  ) {
    throw new Error(`The runtime inspection returned invalid output for ${reference}.`);
  }
  return {
    leakedPaths: selectForbiddenFirstPartyPaths(parsed.paths),
    runtimeIdentity: { gid: parsed.gid, uid: parsed.uid },
  };
}

export function parseReleaseOptions(arguments_) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      'allow-dirty': { type: 'boolean', default: false },
      output: { type: 'string', default: defaultOutputPath },
    },
    allowPositionals: false,
    strict: true,
  });
  const outputPath = resolve(repositoryRoot, values.output);
  const relativeOutput = relative(repositoryRoot, outputPath);
  if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
    throw new Error('The release manifest must stay inside the repository.');
  }
  return {
    allowDirty: values['allow-dirty'],
    outputPath,
  };
}

export async function buildRelease(options) {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  const sourceDateEpoch = run('git', ['show', '-s', '--format=%ct', 'HEAD']).trim();
  const status = run('git', ['status', '--porcelain', '--untracked-files=all']).trim();
  const sourceTree = status.length === 0 ? 'clean' : 'dirty';
  validateReleaseIdentity(version, revision, sourceDateEpoch);
  if (sourceTree === 'dirty' && !options.allowDirty) {
    throw new Error('Refusing to build release images from a dirty source tree.');
  }

  const imageRecords = [];
  for (const definition of createImageDefinitions(version, revision)) {
    process.stdout.write(`Building ${definition.reference} from ${revision.slice(0, 12)}.\n`);
    run('docker', [
      'build',
      '--file',
      'infra/Dockerfile',
      '--target',
      definition.target,
      '--tag',
      definition.reference,
      '--build-arg',
      `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
      '--build-arg',
      `WALKZ_SOURCE_REVISION=${revision}`,
      '--build-arg',
      `WALKZ_VERSION=${version}`,
      '--provenance=false',
      '.',
    ], {
      stdio: 'inherit',
      env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
    });
    const inspection = readInspection(definition.reference);
    const history = run('docker', [
      'history',
      '--no-trunc',
      '--format',
      '{{.CreatedBy}}',
      definition.reference,
    ]);
    const runtime = inspectImageRuntime(definition.reference);
    imageRecords.push(verifyImageInspection({
      definition,
      inspection,
      leakedPaths: runtime.leakedPaths,
      history,
      revision,
      runtimeIdentity: runtime.runtimeIdentity,
      sourceDateEpoch,
      version,
    }));
  }

  const manifest = createReleaseManifest({
    version,
    revision,
    sourceDateEpoch,
    sourceTree,
    images: imageRecords,
  });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, serializeReleaseManifest(manifest), 'utf8');
  process.stdout.write(`Verified release manifest: ${options.outputPath}\n`);
  return manifest;
}

async function main() {
  try {
    const options = parseReleaseOptions(process.argv.slice(2));
    await buildRelease(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release build failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
