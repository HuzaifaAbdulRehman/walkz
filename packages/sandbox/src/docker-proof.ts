import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  parseProofExecutionResult,
  parseProofPlan,
  type CapturedOutput,
  type CommandExecutionResult,
  type CommandSpec,
  type ProofExecutionResult,
  type ProofPlan,
} from '@walkz/contracts';

import {
  executeCommand,
  type ExecuteCommandOptions,
} from './runner.js';

const PLAN_DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const PROOF_DIRECTORY = '.walkz-proof';
const CONTAINER_WORKSPACE = '/workspace';
const CLEANUP_TIMEOUT_MS = 15_000;

export interface DockerProofWorkspace {
  revision: 'base' | 'head';
  sha: string;
  path: string;
}

export type DockerCommandExecutor = (
  spec: CommandSpec,
  options: ExecuteCommandOptions,
) => Promise<CommandExecutionResult>;

export interface ExecuteDockerProofOptions {
  dockerExecutable?: string;
  signal?: AbortSignal;
  parentEnvironment?: NodeJS.ProcessEnv;
  executor?: DockerCommandExecutor;
  containerNameFactory?: (
    revision: DockerProofWorkspace['revision'],
  ) => string;
  containerUser?: string;
  now?: () => Date;
}

export interface ProofExecutionPair {
  base: ProofExecutionResult;
  head: ProofExecutionResult;
}

interface PreparedProofWorkspace {
  root: string;
  proofRoot: string;
}

function emptyOutput(): CapturedOutput {
  return {
    text: '',
    originalBytes: 0,
    truncated: false,
    redacted: false,
  };
}

function resolveContainerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined && uid !== 0) {
    return uid + ':' + gid;
  }
  return '65532:65532';
}

function assertPlanDigest(value: string): string {
  if (!PLAN_DIGEST_PATTERN.test(value)) {
    throw new Error('Proof plan digest must be a SHA-256 value.');
  }
  return value.toLowerCase();
}

function assertContainerName(value: string): void {
  if (!CONTAINER_NAME_PATTERN.test(value)) {
    throw new Error('Generated proof container name is unsafe.');
  }
}

function assertWorkspaceMatchesPlan(
  plan: ProofPlan,
  workspace: DockerProofWorkspace,
): void {
  const expectedSha =
    workspace.revision === 'base' ? plan.baseSha : plan.headSha;
  if (workspace.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('Proof workspace SHA does not match the proof plan.');
  }
}

function safeMountSource(path: string): string {
  if (path.includes(',') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Proof workspace path cannot be encoded as a Docker mount.');
  }
  return path;
}

function containerWorkingDirectory(cwd: string): string {
  return cwd === '.' ? CONTAINER_WORKSPACE : CONTAINER_WORKSPACE + '/' + cwd;
}

function formatNanoCpus(nanoCpus: number): string {
  const whole = Math.floor(nanoCpus / 1_000_000_000);
  const fraction = String(nanoCpus % 1_000_000_000).padStart(9, '0');
  return whole + '.' + fraction;
}

export function buildDockerProofArguments(
  planInput: ProofPlan,
  workspacePath: string,
  containerName: string,
  containerUser = resolveContainerUser(),
): string[] {
  const plan = parseProofPlan(planInput);
  assertContainerName(containerName);
  if (!/^\d+:\d+$/.test(containerUser) || containerUser === '0:0') {
    throw new Error('Proof containers must use a non-root numeric user.');
  }
  const [uid, gid] = containerUser.split(':');

  return [
    'run',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    plan.isolation.network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--ipc',
    'none',
    '--pids-limit',
    String(plan.limits.pidsLimit),
    '--memory',
    String(plan.limits.memoryBytes),
    '--memory-swap',
    String(plan.limits.memoryBytes),
    '--cpus',
    formatNanoCpus(plan.limits.nanoCpus),
    '--ulimit',
    'core=0:0',
    '--ulimit',
    'nofile=256:256',
    '--user',
    containerUser,
    '--hostname',
    'walkz-proof',
    '--init',
    '--stop-timeout',
    '1',
    '--mount',
    'type=bind,source=' +
      safeMountSource(workspacePath) +
      ',target=' +
      CONTAINER_WORKSPACE +
      ',readonly',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=' +
      plan.limits.maxWritableBytes +
      ',uid=' +
      uid +
      ',gid=' +
      gid +
      ',mode=1770',
    '--workdir',
    containerWorkingDirectory(plan.command.cwd),
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--env',
    'LANG=C.UTF-8',
    '--env',
    'LC_ALL=C.UTF-8',
    '--env',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    plan.containerImage,
    plan.command.executable,
    ...plan.command.args,
  ];
}

function containedPath(root: string, repositoryPath: string): string {
  const target = resolve(root, ...repositoryPath.split('/'));
  const fromRoot = relative(root, target);
  if (
    fromRoot.length === 0 ||
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('Proof file escaped its workspace.');
  }
  return target;
}

function decodeProofFile(contentBase64: string, expectedDigest: string): Buffer {
  const content = Buffer.from(contentBase64, 'base64');
  if (content.toString('base64') !== contentBase64) {
    throw new Error('Proof file content must use canonical base64.');
  }
  const actualDigest = createHash('sha256').update(content).digest('hex');
  if (actualDigest !== expectedDigest.toLowerCase()) {
    throw new Error('Proof file digest does not match its content.');
  }
  return content;
}

async function prepareProofWorkspace(
  plan: ProofPlan,
  workspacePath: string,
): Promise<PreparedProofWorkspace> {
  const root = await realpath(workspacePath);
  if (!(await stat(root)).isDirectory()) {
    throw new Error('Proof workspace must be a directory.');
  }
  const proofRoot = containedPath(root, PROOF_DIRECTORY);
  await mkdir(proofRoot, { mode: 0o700 });

  try {
    for (const file of plan.files) {
      const target = containedPath(root, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(
        target,
        decodeProofFile(file.contentBase64, file.sha256),
        { flag: 'wx', mode: 0o444 },
      );
    }
    return { root, proofRoot };
  } catch (error) {
    await rm(proofRoot, { recursive: true, force: true });
    throw error;
  }
}

function outputArtifacts(
  stdout: CapturedOutput,
  stderr: CapturedOutput,
): ProofExecutionResult['artifacts'] {
  return (
    [
      ['stdout', stdout],
      ['stderr', stderr],
    ] as const
  ).flatMap(([kind, output]) => {
    const bytes = Buffer.from(output.text);
    return bytes.length === 0
      ? []
      : [
          {
            kind,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sizeBytes: bytes.length,
          },
        ];
  });
}

function proofOutput(output: CapturedOutput) {
  return {
    summary: output.text,
    originalBytes: output.originalBytes,
    truncated: output.truncated,
    redacted: output.redacted,
  };
}

function executionOutcome(
  execution: CommandExecutionResult,
): ProofExecutionResult['outcome'] {
  if (execution.outcome === 'succeeded') {
    return 'passed';
  }
  if (execution.outcome === 'failed') {
    return execution.exitCode !== null &&
      [125, 126, 127].includes(execution.exitCode)
      ? 'infrastructure_error'
      : 'failed';
  }
  if (execution.outcome === 'timed_out') {
    return 'timed_out';
  }
  if (execution.outcome === 'cancelled') {
    return 'cancelled';
  }
  return 'infrastructure_error';
}

function createResult(
  plan: ProofPlan,
  planDigest: string,
  workspace: DockerProofWorkspace,
  execution: CommandExecutionResult,
  now: () => Date,
  forceInfrastructureError = false,
): ProofExecutionResult {
  return parseProofExecutionResult({
    planDigest,
    commandDigest: plan.commandDigest,
    revision: workspace.revision,
    sha: workspace.sha,
    outcome: forceInfrastructureError
      ? 'infrastructure_error'
      : executionOutcome(execution),
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    stdout: proofOutput(execution.stdout),
    stderr: proofOutput(execution.stderr),
    artifacts: outputArtifacts(execution.stdout, execution.stderr),
    recordedAt: now().toISOString(),
  });
}

function setupFailureResult(
  plan: ProofPlan,
  planDigest: string,
  workspace: DockerProofWorkspace,
  startedAt: number,
  now: () => Date,
): ProofExecutionResult {
  return parseProofExecutionResult({
    planDigest,
    commandDigest: plan.commandDigest,
    revision: workspace.revision,
    sha: workspace.sha,
    outcome: 'infrastructure_error',
    exitCode: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout: proofOutput(emptyOutput()),
    stderr: {
      summary: 'Proof container setup or cleanup failed.',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    },
    artifacts: [],
    recordedAt: now().toISOString(),
  });
}

function cleanupSpec(
  dockerExecutable: string,
  repositoryRoot: string,
  containerName: string,
): CommandSpec {
  return {
    executable: dockerExecutable,
    args: ['container', 'rm', '--force', '--volumes', containerName],
    repositoryRoot,
    cwd: '.',
    timeoutMs: CLEANUP_TIMEOUT_MS,
    maxOutputBytesPerStream: 16_384,
  };
}

function cleanupVerificationSpec(
  dockerExecutable: string,
  repositoryRoot: string,
  containerName: string,
): CommandSpec {
  return {
    executable: dockerExecutable,
    args: [
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      'name=^/' + containerName + '$',
    ],
    repositoryRoot,
    cwd: '.',
    timeoutMs: CLEANUP_TIMEOUT_MS,
    maxOutputBytesPerStream: 16_384,
  };
}

async function cleanContainer(
  executor: DockerCommandExecutor,
  dockerExecutable: string,
  repositoryRoot: string,
  containerName: string,
  parentEnvironment: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
  const executeOptions =
    parentEnvironment === undefined ? {} : { parentEnvironment };
  try {
    await executor(
      cleanupSpec(dockerExecutable, repositoryRoot, containerName),
      executeOptions,
    );
    const verification = await executor(
      cleanupVerificationSpec(
        dockerExecutable,
        repositoryRoot,
        containerName,
      ),
      executeOptions,
    );
    return (
      verification.outcome === 'succeeded' &&
      verification.stdout.text.trim().length === 0
    );
  } catch {
    return false;
  }
}

export async function executeProofInContainer(
  planInput: ProofPlan,
  planDigestInput: string,
  workspace: DockerProofWorkspace,
  options: ExecuteDockerProofOptions = {},
): Promise<ProofExecutionResult> {
  const startedAt = Date.now();
  const plan = parseProofPlan(planInput);
  const planDigest = assertPlanDigest(planDigestInput);
  assertWorkspaceMatchesPlan(plan, workspace);
  const now = options.now ?? (() => new Date());

  if (options.signal?.aborted === true) {
    return parseProofExecutionResult({
      planDigest,
      commandDigest: plan.commandDigest,
      revision: workspace.revision,
      sha: workspace.sha,
      outcome: 'cancelled',
      exitCode: null,
      durationMs: 0,
      stdout: proofOutput(emptyOutput()),
      stderr: proofOutput(emptyOutput()),
      artifacts: [],
      recordedAt: now().toISOString(),
    });
  }

  const executor = options.executor ?? executeCommand;
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  const containerName =
    options.containerNameFactory?.(workspace.revision) ??
    'walkz-proof-' +
      workspace.revision +
      '-' +
      randomUUID().replaceAll('-', '').slice(0, 12);
  assertContainerName(containerName);
  let prepared: PreparedProofWorkspace | undefined;
  let execution: CommandExecutionResult | undefined;
  let cleanupFailed = false;

  try {
    prepared = await prepareProofWorkspace(plan, workspace.path);
    execution = await executor(
      {
        executable: dockerExecutable,
        args: buildDockerProofArguments(
          plan,
          prepared.root,
          containerName,
          options.containerUser,
        ),
        repositoryRoot: prepared.root,
        cwd: '.',
        timeoutMs: plan.limits.timeoutMs,
        maxOutputBytesPerStream: plan.limits.maxOutputBytesPerStream,
      },
      {
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.parentEnvironment !== undefined && {
          parentEnvironment: options.parentEnvironment,
        }),
      },
    );
  } catch {
    return setupFailureResult(plan, planDigest, workspace, startedAt, now);
  } finally {
    if (prepared !== undefined) {
      cleanupFailed = !(await cleanContainer(
        executor,
        dockerExecutable,
        prepared.root,
        containerName,
        options.parentEnvironment,
      ));
      try {
        await rm(prepared.proofRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (execution === undefined) {
    return setupFailureResult(plan, planDigest, workspace, startedAt, now);
  }
  return createResult(
    plan,
    planDigest,
    workspace,
    execution,
    now,
    cleanupFailed,
  );
}

export async function executeProofPair(
  plan: ProofPlan,
  planDigest: string,
  workspaces: {
    base: DockerProofWorkspace;
    head: DockerProofWorkspace;
  },
  options: ExecuteDockerProofOptions = {},
): Promise<ProofExecutionPair> {
  const base = await executeProofInContainer(
    plan,
    planDigest,
    workspaces.base,
    options,
  );
  const head = await executeProofInContainer(
    plan,
    planDigest,
    workspaces.head,
    options,
  );
  return { base, head };
}
