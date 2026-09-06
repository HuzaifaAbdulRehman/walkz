import { realpath } from 'node:fs/promises';

import type { RepositoryConfig } from '@walkz/contracts';
import { locateRepositoryRoot } from '@walkz/git';
import {
  buildCommandPlan,
  checkCommandAvailability,
  executeCommand,
} from '@walkz/sandbox';

import { loadWalkzConfig, WALKZ_CONFIG_FILENAME } from './config.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface DoctorCheck {
  status: DoctorStatus;
  name: string;
  message: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 2 | 3;
}

export interface DoctorOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

function nodeCheck(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major >= 24
    ? {
        status: 'PASS',
        name: 'Node',
        message: version + ' meets the Node 24+ requirement.',
      }
    : {
        status: 'FAIL',
        name: 'Node',
        message: version + ' is unsupported. Install Node 24 or newer.',
      };
}

async function gitCheck(
  executionRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const result = await executeCommand(
    {
      executable: 'git',
      args: ['--version'],
      repositoryRoot: executionRoot,
      timeoutMs: 5_000,
      maxOutputBytesPerStream: 8_192,
    },
    {
      parentEnvironment: environment,
    },
  );

  if (result.outcome !== 'succeeded') {
    return {
      status: 'FAIL',
      name: 'Git',
      message: 'Git could not be started. Install Git and make it available on PATH.',
    };
  }

  const version = result.stdout.text.trim().replace(/^git version\s+/i, '');
  return {
    status: 'PASS',
    name: 'Git',
    message: (version || 'available') + ' is available.',
  };
}

async function repositoryCheck(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const result = await executeCommand(
    {
      executable: 'git',
      args: ['rev-parse', '--show-toplevel'],
      repositoryRoot,
      timeoutMs: 5_000,
      maxOutputBytesPerStream: 8_192,
    },
    {
      parentEnvironment: environment,
    },
  );

  if (result.outcome !== 'succeeded') {
    const ownershipRefused = result.stderr.text
      .toLowerCase()
      .includes('dubious ownership');
    return {
      status: 'FAIL',
      name: 'Repository',
      message: ownershipRefused
        ? "Git refused this working tree because its ownership is not trusted."
        : 'Git does not recognize this directory as a working tree.',
    };
  }

  return {
    status: 'PASS',
    name: 'Repository',
    message: repositoryRoot,
  };
}

async function commandCheck(
  config: RepositoryConfig,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  if (config.commands.length === 0) {
    return {
      status: 'WARN',
      name: 'Commands',
      message:
        'No commands are configured. Reviews will have no deterministic command evidence.',
    };
  }

  const plan = buildCommandPlan(config, repositoryRoot);
  const results = await Promise.all(
    plan.map((command) =>
      checkCommandAvailability(command, {
        parentEnvironment: environment,
      }),
    ),
  );
  const unsafe = results
    .map((availability, index) => ({
      availability,
      configuredCommand: config.commands[index],
    }))
    .find(
      ({ availability, configuredCommand }) =>
        availability.status === 'unsafe' && configuredCommand !== undefined,
    );

  if (unsafe?.configuredCommand !== undefined) {
    return {
      status: 'FAIL',
      name: 'Commands',
      message:
        'Command "' +
        unsafe.configuredCommand.id +
        '" is unsafe. ' +
        (unsafe.availability.errorMessage ?? 'Check its configuration.'),
    };
  }

  const missingRequired = results
    .map((availability, index) => ({
      availability,
      configuredCommand: config.commands[index],
    }))
    .find(
      ({ availability, configuredCommand }) =>
        availability.status === 'missing' &&
        configuredCommand?.required === true,
    );

  if (missingRequired?.configuredCommand !== undefined) {
    return {
      status: 'FAIL',
      name: 'Commands',
      message:
        'Command "' +
        missingRequired.configuredCommand.id +
        '" is not ready. ' +
        (missingRequired.availability.errorMessage ??
          'Its executable is unavailable.'),
    };
  }

  const unavailableOptional = results
    .map((availability, index) => ({
      availability,
      configuredCommand: config.commands[index],
    }))
    .find(
      ({ availability, configuredCommand }) =>
        availability.status === 'missing' &&
        configuredCommand?.required === false,
    );

  if (unavailableOptional?.configuredCommand !== undefined) {
    return {
      status: 'WARN',
      name: 'Commands',
      message:
        'Optional command "' +
        unavailableOptional.configuredCommand.id +
        '" is unavailable. ' +
        (unavailableOptional.availability.errorMessage ??
          'Its executable was not found.'),
    };
  }

  if (config.commandApprovalPolicy === 'trusted_config') {
    return {
      status: 'WARN',
      name: 'Commands',
      message:
        config.commands.length +
        ' commands are ready, but the config permits them to run without another prompt.',
    };
  }

  return {
    status: 'PASS',
    name: 'Commands',
    message:
      config.commands.length +
      ' commands are ready. Walkz will ask before running them.',
  };
}

function groqCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  return typeof environment.GROQ_API_KEY === 'string' &&
    environment.GROQ_API_KEY.trim().length > 0
    ? {
        status: 'PASS',
        name: 'Groq key',
        message: 'GROQ_API_KEY is set.',
      }
    : {
        status: 'WARN',
        name: 'Groq key',
        message:
          'GROQ_API_KEY is missing. Model-backed review will remain unavailable until it is set.',
      };
}

function resultExitCode(checks: readonly DoctorCheck[]): 0 | 2 | 3 {
  if (checks.some((check) => check.status === 'FAIL')) {
    return 3;
  }
  return checks.some((check) => check.status === 'WARN') ? 2 : 0;
}

export function renderDoctorResult(result: DoctorResult): string {
  const lines = ['Walkz doctor', ''];
  for (const check of result.checks) {
    lines.push(check.status.padEnd(4) + ' ' + check.name + ': ' + check.message);
  }

  const passed = result.checks.filter((check) => check.status === 'PASS').length;
  const warnings = result.checks.filter((check) => check.status === 'WARN').length;
  const failed = result.checks.filter((check) => check.status === 'FAIL').length;
  const skipped = result.checks.filter((check) => check.status === 'SKIP').length;
  const warningLabel = warnings === 1 ? 'warning' : 'warnings';
  const skippedSummary = skipped === 0 ? '' : ', ' + skipped + ' skipped';
  lines.push(
    '',
    'Result: ' +
      passed +
      ' passed, ' +
      warnings +
      ' ' +
      warningLabel +
      ', ' +
      failed +
      ' failed' +
      skippedSummary +
      '.',
  );
  return lines.join('\n') + '\n';
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const environment = options.environment ?? process.env;
  const checks: DoctorCheck[] = [
    nodeCheck(options.nodeVersion ?? process.versions.node),
  ];
  const executionRoot = await realpath(options.cwd);
  checks.push(await gitCheck(executionRoot, environment));

  let repositoryRoot: string | undefined;
  try {
    repositoryRoot = await locateRepositoryRoot(executionRoot);
    checks.push(await repositoryCheck(repositoryRoot, environment));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      status: 'FAIL',
      name: 'Repository',
      message:
        detail.includes('No Git repository')
          ? 'No Git working tree was found from the current directory.'
          : 'Repository discovery failed. ' + detail,
    });
  }

  let config: RepositoryConfig | undefined;
  if (repositoryRoot === undefined) {
    checks.push({
      status: 'SKIP',
      name: 'Config',
      message: 'Repository discovery failed, so the config could not be checked.',
    });
  } else {
    try {
      config = await loadWalkzConfig(repositoryRoot);
      checks.push({
        status: 'PASS',
        name: 'Config',
        message: WALKZ_CONFIG_FILENAME + ' uses schema version ' + config.schemaVersion + '.',
      });
    } catch (error) {
      checks.push({
        status: 'FAIL',
        name: 'Config',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (repositoryRoot === undefined || config === undefined) {
    checks.push({
      status: 'SKIP',
      name: 'Commands',
      message: 'A valid repository config is required before commands can be checked.',
    });
  } else {
    checks.push(await commandCheck(config, repositoryRoot, environment));
  }

  checks.push(groqCheck(environment));
  return {
    checks,
    exitCode: resultExitCode(checks),
  };
}
