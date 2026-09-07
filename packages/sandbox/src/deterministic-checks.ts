import type {
  ApprovedCommand,
  CommandApprovalDecision,
  CommandExecutionResult,
  CommandSpec,
  DeterministicCheckRun,
  RepositoryConfig,
} from '@walkz/contracts';

import { buildCommandPlan } from './command-plan.js';
import {
  executeCommand,
  type ExecuteCommandOptions,
} from './runner.js';

export type CommandApprovalRequester = (
  commands: readonly ApprovedCommand[],
) => boolean | Promise<boolean>;

export interface RunDeterministicChecksOptions
  extends ExecuteCommandOptions {
  requestApproval?: CommandApprovalRequester;
  executor?: (
    spec: CommandSpec,
    options: ExecuteCommandOptions,
  ) => Promise<CommandExecutionResult>;
}

export async function requestCommandApproval(
  config: RepositoryConfig,
  requester?: CommandApprovalRequester,
): Promise<CommandApprovalDecision> {
  if (config.commands.length === 0) {
    return { status: 'not_required', source: 'none' };
  }

  if (config.commandApprovalPolicy === 'trusted_config') {
    return { status: 'approved', source: 'trusted_config' };
  }

  if (requester === undefined) {
    return { status: 'unavailable', source: 'none' };
  }

  return (await requester(config.commands))
    ? { status: 'approved', source: 'user' }
    : { status: 'declined', source: 'user' };
}

function skippedRun(
  approval: CommandApprovalDecision,
  config: RepositoryConfig,
): DeterministicCheckRun {
  return {
    approval,
    plannedCount: config.commands.length,
    checks: [],
    status: config.commands.some((command) => command.required)
      ? 'incomplete'
      : 'complete',
  };
}

function classifyRun(
  run: Omit<DeterministicCheckRun, 'status'>,
): DeterministicCheckRun['status'] {
  const requiredOutcomes = run.checks
    .filter((check) => check.required)
    .map((check) => check.execution.outcome);

  if (
    requiredOutcomes.some(
      (outcome) =>
        outcome === 'spawn_error' || outcome === 'configuration_error',
    )
  ) {
    return 'error';
  }

  if (
    run.checks.length < run.plannedCount ||
    requiredOutcomes.some(
      (outcome) => outcome === 'timed_out' || outcome === 'cancelled',
    )
  ) {
    return 'incomplete';
  }

  return 'complete';
}

export async function runDeterministicChecks(
  config: RepositoryConfig,
  repositoryRoot: string,
  options: RunDeterministicChecksOptions = {},
): Promise<DeterministicCheckRun> {
  const approval = await requestCommandApproval(
    config,
    options.requestApproval,
  );

  if (approval.status === 'not_required') {
    return {
      approval,
      plannedCount: 0,
      checks: [],
      status: 'complete',
    };
  }

  if (approval.status !== 'approved') {
    return skippedRun(approval, config);
  }

  const commandPlan = buildCommandPlan(config, repositoryRoot);
  const executor = options.executor ?? executeCommand;
  const checks: DeterministicCheckRun['checks'] = [];

  for (const [index, command] of commandPlan.entries()) {
    const configuredCommand = config.commands[index];
    if (configuredCommand === undefined) {
      throw new Error('Command plan no longer matches configuration.');
    }

    const execution = await executor(command, {
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.parentEnvironment !== undefined && {
        parentEnvironment: options.parentEnvironment,
      }),
    });
    checks.push({
      commandId: configuredCommand.id,
      required: configuredCommand.required,
      command,
      execution,
    });

    if (execution.outcome === 'cancelled') {
      break;
    }
  }

  const run = {
    approval,
    plannedCount: commandPlan.length,
    checks,
  };
  return { ...run, status: classifyRun(run) };
}
