import { createDefaultWalkzConfig } from '@walkz/contracts';
import { locateRepositoryRoot } from '@walkz/git';
import { discoverRepositoryCommands, executeCommand } from '@walkz/sandbox';

import { writeWalkzConfig } from './config.js';

export interface InitOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
}

export interface InitResult {
  exitCode: 0 | 3;
  message: string;
  error?: string;
}

async function verifyGitRepository(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await executeCommand(
    {
      executable: 'git',
      args: ['rev-parse', '--is-inside-work-tree'],
      repositoryRoot,
      timeoutMs: 5_000,
      maxOutputBytesPerStream: 8_192,
    },
    {
      parentEnvironment: environment,
    },
  );

  if (result.outcome !== 'succeeded' || result.stdout.text.trim() !== 'true') {
    throw new Error(
      'Git could not verify this working tree. Check Git, then try again.',
    );
  }
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const environment = options.environment ?? process.env;

  try {
    const repositoryRoot = await locateRepositoryRoot(options.cwd);
    await verifyGitRepository(repositoryRoot, environment);
    const commands = await discoverRepositoryCommands(repositoryRoot);
    const config = createDefaultWalkzConfig(commands);
    const configPath = await writeWalkzConfig(repositoryRoot, config);
    const commandMessage =
      commands.length === 0
        ? 'No standard npm commands were found. Add approved commands before review.'
        : commands.length +
          ' standard npm commands were added. Walkz will ask before running them.';

    return {
      exitCode: 0,
      message:
        'Created ' +
        configPath +
        '.\n' +
        commandMessage +
        '\nRun "walkz doctor" to check the setup.\n',
    };
  } catch (error) {
    return {
      exitCode: 3,
      message: '',
      error: (error instanceof Error ? error.message : String(error)) + '\n',
    };
  }
}
