import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 64 * 1024;
const ENVIRONMENT_KEYS = [
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const;

export class GitCommandError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
  }
}

export class GitOutputLimitError extends GitCommandError {
  readonly partialStdout: Buffer;

  constructor(partialStdout: Buffer) {
    super('Git output exceeded its configured byte limit.');
    this.name = 'GitOutputLimitError';
    this.partialStdout = partialStdout;
  }
}

export interface RunGitOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const match = Object.keys(process.env).find(
      (name) => name.toUpperCase() === key,
    );
    if (match !== undefined && process.env[match] !== undefined) {
      environment[match] = process.env[match];
    }
  }
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function executableCandidates(environment: NodeJS.ProcessEnv): string[] {
  const pathEntry = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === 'PATH',
  );
  const pathValue = pathEntry?.[1] ?? '';
  const pathExtEntry = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === 'PATHEXT',
  );
  const extensions =
    process.platform === 'win32'
      ? (pathExtEntry?.[1] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  const names = ['git', ...extensions.map((extension) => 'git' + extension)];

  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => {
      const unquoted = directory.replace(/^"(.*)"$/, '$1');
      return names.map((name) => resolve(unquoted, name));
    });
}

async function locateGitExecutable(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const accessMode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const candidate of executableCandidates(environment)) {
    if (extname(candidate).length === 0 && process.platform === 'win32') {
      continue;
    }
    try {
      await access(candidate, accessMode);
      if ((await stat(candidate)).isFile()) {
        return await realpath(candidate);
      }
    } catch {}
  }
  throw new GitCommandError('Git is not available on PATH.');
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  retainedBytes: number,
  limit: number,
): number {
  if (retainedBytes >= limit) {
    return retainedBytes;
  }
  const retained = chunk.subarray(0, limit - retainedBytes);
  chunks.push(retained);
  return retainedBytes + retained.length;
}

export async function runGitBuffer(
  repositoryRoot: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<Buffer> {
  if (args.some((argument) => argument.includes('\0'))) {
    throw new GitCommandError('Git arguments cannot contain NUL bytes.');
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new GitCommandError('Git output limit must be a positive integer.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new GitCommandError('Git timeout must be between 1 and 120000 milliseconds.');
  }

  const cwd = await realpath(repositoryRoot);
  if (!(await stat(cwd)).isDirectory()) {
    throw new GitCommandError('Repository root must be a directory.');
  }
  const environment = inheritedEnvironment();
  const executable = await locateGitExecutable(environment);
  if (options.signal?.aborted === true) {
    throw new GitCommandError('Git command was cancelled.');
  }

  return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn(
      executable,
      ['--no-pager', '-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectOnce(new GitCommandError('Git command timed out.'));
    }, timeoutMs);
    timeout.unref();
    const onAbort = (): void => {
      child.kill('SIGTERM');
      rejectOnce(new GitCommandError('Git command was cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
    }

    child.stdout.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      stdoutBytes += chunk.length;
      const retainedBytes = stdoutChunks.reduce(
        (total, item) => total + item.length,
        0,
      );
      appendBounded(stdoutChunks, chunk, retainedBytes, maxOutputBytes);
      if (stdoutBytes > maxOutputBytes && !overflowed) {
        overflowed = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      stderrBytes = appendBounded(
        stderrChunks,
        chunk,
        stderrBytes,
        STDERR_LIMIT,
      );
    });
    child.once('error', (error) => {
      rejectOnce(new GitCommandError('Git could not be started: ' + error.message));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (settled) {
        return;
      }
      settled = true;
      const stdout = Buffer.concat(stdoutChunks);
      if (overflowed) {
        rejectPromise(new GitOutputLimitError(stdout));
        return;
      }
      if (exitCode !== 0) {
        rejectPromise(
          new GitCommandError('Git command failed.', exitCode),
        );
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function runGitText(
  repositoryRoot: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  const output = await runGitBuffer(repositoryRoot, args, options);
  if (!isUtf8(output)) {
    throw new GitCommandError('Git returned text that is not valid UTF-8.');
  }
  return output.toString('utf8');
}
