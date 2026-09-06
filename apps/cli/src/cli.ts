import { parseArgs } from 'node:util';

import { renderDoctorResult, runDoctor } from './doctor.js';
import { runInit } from './init.js';

const HELP = [
  'Walkz local setup',
  '',
  'Usage:',
  '  walkz init',
  '  walkz doctor',
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
}

function defaultIo(): CliIo {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
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
  switch (parsed.positionals[0]) {
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
    default:
      io.stderr(
        'Unknown command "' +
          parsed.positionals[0] +
          '". Run "walkz --help" for usage.\n',
      );
      return 3;
  }
}
