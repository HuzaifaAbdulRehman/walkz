import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import type {
  ApprovedCommand,
  ProviderAdapter,
} from '@walkz/contracts';
import type { CommandApprovalRequester } from '@walkz/sandbox';

import { renderDoctorResult, runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runReview } from './review.js';

const HELP = [
  'Walkz local setup',
  '',
  'Usage:',
  '  walkz init',
  '  walkz doctor',
  '  walkz review [--staged] [--no-model] [--json]',
  '  walkz --help',
  '',
].join('\n');

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface RunCliOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  io?: CliIo;
  nodeVersion?: string;
  provider?: ProviderAdapter;
  requestCommandApproval?: CommandApprovalRequester;
}

function defaultIo(): CliIo {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  };
}

function renderCommand(command: ApprovedCommand): string {
  return (
    JSON.stringify([command.executable, ...command.args]) +
    ' (cwd ' +
    command.cwd +
    ')'
  );
}

function terminalApproval(io: CliIo): CommandApprovalRequester | undefined {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    return undefined;
  }
  return async (commands) => {
    io.stderr('Walkz needs approval to run these commands:\n');
    for (const command of commands) {
      io.stderr('  ' + command.id + ': ' + renderCommand(command) + '\n');
    }
    const reader = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const answer = await reader.question('Run these commands? [y/N] ');
      return /^(?:y|yes)$/i.test(answer.trim());
    } finally {
      reader.close();
    }
  };
}

export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        help: {
          type: 'boolean',
          short: 'h',
        },
        json: {
          type: 'boolean',
        },
        'no-model': {
          type: 'boolean',
        },
        staged: {
          type: 'boolean',
        },
      },
      strict: true,
    });
  } catch {
    io.stderr('Invalid arguments. Run "walkz --help" for usage.\n');
    return 3;
  }

  if (parsed.values.help === true) {
    io.stdout(HELP);
    return 0;
  }

  if (parsed.positionals.length !== 1) {
    io.stderr('Choose one command. Run "walkz --help" for usage.\n');
    return 3;
  }

  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const command = parsed.positionals[0];
  const hasReviewOptions =
    parsed.values.json === true ||
    parsed.values['no-model'] === true ||
    parsed.values.staged === true;
  if (command !== 'review' && hasReviewOptions) {
    io.stderr('Review options can only be used with "walkz review".\n');
    return 3;
  }
  switch (command) {
    case 'init': {
      const result = await runInit({ cwd, environment });
      if (result.message.length > 0) {
        io.stdout(result.message);
      }
      if (result.error !== undefined) {
        io.stderr(result.error);
      }
      return result.exitCode;
    }
    case 'doctor': {
      try {
        const result = await runDoctor({
          cwd,
          environment,
          ...(options.nodeVersion !== undefined && {
            nodeVersion: options.nodeVersion,
          }),
        });
        io.stdout(renderDoctorResult(result));
        return result.exitCode;
      } catch (error) {
        io.stderr(
          'Doctor could not inspect this directory. ' +
            (error instanceof Error ? error.message : String(error)) +
            '\n',
        );
        return 3;
      }
    }
    case 'review': {
      try {
        const requestCommandApproval =
          options.requestCommandApproval ?? terminalApproval(io);
        const review = await runReview({
          cwd,
          environment,
          staged: parsed.values.staged === true,
          noModel: parsed.values['no-model'] === true,
          json: parsed.values.json === true,
          ...(options.provider !== undefined && {
            provider: options.provider,
          }),
          ...(requestCommandApproval !== undefined && {
            requestCommandApproval,
          }),
          onProviderAccess: (access) => {
            io.stderr('Provider privacy: ' + access.privacyNotice + '\n');
            if (access.dataControlsUrl !== null) {
              io.stderr('Data controls: ' + access.dataControlsUrl + '\n');
            }
          },
        });
        io.stdout(review.output);
        return review.exitCode;
      } catch (error) {
        io.stderr(
          'Review could not start. ' +
            (error instanceof Error ? error.message : String(error)) +
            '\n',
        );
        return 3;
      }
    }
    default:
      io.stderr(
        'Unknown command "' +
          command +
          '". Run "walkz --help" for usage.\n',
      );
      return 3;
  }
}
