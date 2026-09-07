import {
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseProofPlan,
  type CommandExecutionResult,
  type CommandSpec,
  type ProofPlan,
} from '@walkz/contracts';

import {
  executeCommand,
  type ExecuteCommandOptions,
} from './runner.js';

const DEFAULT_PREPARATION_TIMEOUT_MS = 5 * 60 * 1_000;
const PREPARATION_OUTPUT_LIMIT = 64 * 1_024;

export type DockerPreparationExecutor = (
  spec: CommandSpec,
  options: ExecuteCommandOptions,
) => Promise<CommandExecutionResult>;

export interface PrepareProofImageOptions {
  dockerExecutable?: string;
  signal?: AbortSignal;
  parentEnvironment?: NodeJS.ProcessEnv;
  executor?: DockerPreparationExecutor;
  temporaryRoot?: string;
  timeoutMs?: number;
}

export interface ProofImagePreparationResult {
  status: 'ready' | 'cancelled' | 'infrastructure_error';
  image: string;
  pull: CommandExecutionResult;
  inspection: CommandExecutionResult | null;
}

function commandOptions(
  options: PrepareProofImageOptions,
): ExecuteCommandOptions {
  return {
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.parentEnvironment !== undefined && {
      parentEnvironment: options.parentEnvironment,
    }),
  };
}

function dockerSpec(
  executable: string,
  args: readonly string[],
  repositoryRoot: string,
  dockerConfig: string,
  timeoutMs: number,
): CommandSpec {
  return {
    executable,
    args,
    repositoryRoot,
    cwd: '.',
    timeoutMs,
    maxOutputBytesPerStream: PREPARATION_OUTPUT_LIMIT,
    environment: {
      DOCKER_CONFIG: dockerConfig,
    },
  };
}

function preparationStatus(
  result: CommandExecutionResult,
): ProofImagePreparationResult['status'] {
  return result.outcome === 'cancelled'
    ? 'cancelled'
    : result.outcome === 'succeeded'
      ? 'ready'
      : 'infrastructure_error';
}

export async function prepareProofImage(
  planInput: ProofPlan,
  workingDirectory: string,
  options: PrepareProofImageOptions = {},
): Promise<ProofImagePreparationResult> {
  const plan = parseProofPlan(planInput);
  const root = await realpath(workingDirectory);
  if (!(await stat(root)).isDirectory()) {
    throw new Error('Proof image preparation directory must be a directory.');
  }
  const temporaryRoot = await realpath(options.temporaryRoot ?? tmpdir());
  if (!(await stat(temporaryRoot)).isDirectory()) {
    throw new Error('Docker configuration root must be a directory.');
  }
  const dockerConfig = await mkdtemp(join(temporaryRoot, 'walkz docker config '));
  const executor = options.executor ?? executeCommand;
  const executable = options.dockerExecutable ?? 'docker';
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS;

  try {
    await writeFile(
      join(dockerConfig, 'config.json'),
      '{"auths":{}}\n',
      { flag: 'wx', mode: 0o600 },
    );
    const pull = await executor(
      dockerSpec(
        executable,
        ['image', 'pull', plan.containerImage],
        root,
        dockerConfig,
        timeoutMs,
      ),
      commandOptions(options),
    );
    if (pull.outcome !== 'succeeded') {
      return {
        status: preparationStatus(pull),
        image: plan.containerImage,
        pull,
        inspection: null,
      };
    }

    const inspection = await executor(
      dockerSpec(
        executable,
        ['image', 'inspect', plan.containerImage],
        root,
        dockerConfig,
        timeoutMs,
      ),
      commandOptions(options),
    );
    return {
      status: preparationStatus(inspection),
      image: plan.containerImage,
      pull,
      inspection,
    };
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}
