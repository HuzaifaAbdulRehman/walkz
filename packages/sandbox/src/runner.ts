import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import {
  delimiter,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isUtf8 } from 'node:buffer';

import type {
  CapturedOutput,
  CommandExecutionResult,
  CommandSpec,
  TerminationReason,
} from '@walkz/contracts';
import { execa } from 'execa';

const DEFAULT_ENVIRONMENT_KEYS = [
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
  'TERM',
  'TMP',
  'TZ',
  'USERPROFILE',
  'WINDIR',
] as const;

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES_PER_STREAM = 10 * 1024 * 1024;
const REDACTION_LOOKAHEAD_BYTES = 64 * 1024;
const TRUNCATION_MARKER = '\n...[truncated]';
const SENSITIVE_NAME_PATTERN =
  /(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|KEY|PASSW(?:OR)?D|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;
const EXECUTION_CONTROL_ENVIRONMENT_PATTERN =
  /^(?:BASH_ENV|COMSPEC|DYLD_.*|ENV|GIT_CONFIG_(?:GLOBAL|SYSTEM)|GIT_SSH_COMMAND|LD_.*|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_USERCONFIG|PATH|PATHEXT|PERL5OPT|PYTHONPATH|RUBYOPT|SHELLOPTS|SSH_ASKPASS|SYSTEMROOT|WINDIR)$/i;

export interface ExecuteCommandOptions {
  signal?: AbortSignal;
  parentEnvironment?: NodeJS.ProcessEnv;
}

export interface OutputSanitizationOptions {
  maxBytes: number;
  originalBytes?: number;
  secrets?: readonly string[];
  wasTruncated?: boolean;
}

export interface TerminableProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface RawCapture {
  buffer: Buffer;
  originalBytes: number;
  truncated: boolean;
}

interface PreparedCommand {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  executable: string;
  secrets: string[];
}

class CommandSpawnError extends Error {}

function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}

function isExecutionControlEnvironmentName(name: string): boolean {
  return EXECUTION_CONTROL_ENVIRONMENT_PATTERN.test(name);
}

function assertPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      name + ' must be an integer between 1 and ' + maximum + '.',
    );
  }
}

function assertSafeString(value: string, name: string): void {
  if (value.length === 0 || value.includes('\0')) {
    throw new Error(name + ' must be non-empty and cannot contain NUL bytes.');
  }
}

function assertNoNul(value: string, name: string): void {
  if (value.includes('\0')) {
    throw new Error(name + ' cannot contain NUL bytes.');
  }
}

function lookupEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string,
): [string, string] | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toUpperCase() === requestedName.toUpperCase(),
  );

  if (actualName === undefined) {
    return undefined;
  }

  const value = environment[actualName];
  return value === undefined ? undefined : [actualName, value];
}

function collectSecrets(environment: NodeJS.ProcessEnv): string[] {
  const uniqueSecrets = new Set<string>();

  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && value.length > 0 && isSensitiveEnvironmentName(name)) {
      uniqueSecrets.add(value);
    }
  }

  return [...uniqueSecrets].sort((left, right) => right.length - left.length);
}

function buildChildEnvironment(
  spec: CommandSpec,
  parentEnvironment: NodeJS.ProcessEnv,
  secrets: readonly string[],
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  const requestedKeys = new Set([
    ...DEFAULT_ENVIRONMENT_KEYS,
    ...(spec.inheritEnvironment ?? []),
  ]);

  for (const requestedName of requestedKeys) {
    assertSafeString(requestedName, 'Environment variable name');
    if (isSensitiveEnvironmentName(requestedName)) {
      throw new Error(
        'Environment variable "' +
          requestedName +
          '" is sensitive and cannot be inherited.',
      );
    }
    if (
      isExecutionControlEnvironmentName(requestedName) &&
      !DEFAULT_ENVIRONMENT_KEYS.some(
        (name) => name.toUpperCase() === requestedName.toUpperCase(),
      )
    ) {
      throw new Error(
        'Environment variable "' +
          requestedName +
          '" can alter command execution and cannot be inherited.',
      );
    }

    const entry = lookupEnvironmentValue(parentEnvironment, requestedName);
    if (entry !== undefined) {
      if (secrets.includes(entry[1])) {
        throw new Error(
          'Environment variable "' +
            requestedName +
            '" contains a protected value and cannot be inherited.',
        );
      }
      childEnvironment[entry[0]] = entry[1];
    }
  }

  for (const [name, value] of Object.entries(spec.environment ?? {})) {
    assertSafeString(name, 'Environment variable name');
    assertNoNul(value, 'Environment variable value');
    if (isSensitiveEnvironmentName(name)) {
      throw new Error(
        'Environment variable "' +
          name +
          '" is sensitive and cannot be passed to commands.',
      );
    }
    if (isExecutionControlEnvironmentName(name)) {
      throw new Error(
        'Environment variable "' +
          name +
          '" can alter command execution and cannot be passed to commands.',
      );
    }
    if (secrets.includes(value)) {
      throw new Error(
        'Environment variable "' +
          name +
          '" contains a protected value and cannot be passed to commands.',
      );
    }
    childEnvironment[name] = value;
  }

  return childEnvironment;
}

async function resolveWorkingDirectory(spec: CommandSpec): Promise<string> {
  const repositoryRoot = await realpath(spec.repositoryRoot);
  if (!(await stat(repositoryRoot)).isDirectory()) {
    throw new Error('Repository root must be a directory.');
  }
  const requestedDirectory =
    spec.cwd === undefined
      ? repositoryRoot
      : isAbsolute(spec.cwd)
        ? spec.cwd
        : resolve(repositoryRoot, spec.cwd);
  const workingDirectory = await realpath(requestedDirectory);
  if (!(await stat(workingDirectory)).isDirectory()) {
    throw new Error('Command working directory must be a directory.');
  }
  const pathFromRoot = relative(repositoryRoot, workingDirectory);

  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith('..' + sep) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Command working directory must stay inside the repository.');
  }

  return workingDirectory;
}

function executableCandidates(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const extensions =
    process.platform === 'win32'
      ? (lookupEnvironmentValue(environment, 'PATHEXT')?.[1] ??
          '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  const hasExtension = extname(executable).length > 0;
  const names = hasExtension
    ? [executable]
    : [executable, ...extensions.map((extension) => executable + extension)];
  const hasPathSeparator =
    isAbsolute(executable) ||
    executable.includes('/') ||
    executable.includes('\\');

  if (hasPathSeparator) {
    return names.map((name) => resolve(cwd, name));
  }

  const pathValue = lookupEnvironmentValue(environment, 'PATH')?.[1] ?? '';
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => {
      const unquotedDirectory = directory.replace(/^"(.*)"$/, '$1');
      return names.map((name) => resolve(unquotedDirectory, name));
    });
}

async function resolveExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const accessMode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;

  for (const candidate of executableCandidates(executable, environment, cwd)) {
    try {
      await access(candidate, accessMode);
      if ((await stat(candidate)).isFile()) {
        return await realpath(candidate);
      }
    } catch {}
  }

  throw new CommandSpawnError(
    'Command executable "' + executable + '" was not found.',
  );
}

async function prepareCommand(
  spec: CommandSpec,
  parentEnvironment: NodeJS.ProcessEnv,
): Promise<PreparedCommand> {
  assertSafeString(spec.executable, 'Command executable');
  spec.args.forEach((argument, index) =>
    assertNoNul(argument, 'Command argument ' + index),
  );
  assertPositiveInteger(spec.timeoutMs, 'Command timeout', MAX_TIMEOUT_MS);
  assertPositiveInteger(
    spec.maxOutputBytesPerStream,
    'Per-stream output limit',
    MAX_OUTPUT_BYTES_PER_STREAM,
  );

  const secrets = collectSecrets(parentEnvironment);
  for (const argument of spec.args) {
    const matchingSecret = secrets.find(
      (secret) =>
        argument === secret || (secret.length >= 8 && argument.includes(secret)),
    );
    if (matchingSecret !== undefined) {
      throw new Error('Command arguments cannot contain a protected value.');
    }
  }

  const cwd = await resolveWorkingDirectory(spec);
  const environment = buildChildEnvironment(spec, parentEnvironment, secrets);
  return {
    cwd,
    environment,
    executable: await resolveExecutable(spec.executable, environment, cwd),
    secrets,
  };
}

async function captureStream(
  stream: NodeJS.ReadableStream | undefined,
  maxBytes: number,
): Promise<RawCapture> {
  if (stream === undefined) {
    return {
      buffer: Buffer.alloc(0),
      originalBytes: 0,
      truncated: false,
    };
  }

  const retainedLimit = maxBytes + REDACTION_LOOKAHEAD_BYTES;
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let originalBytes = 0;

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(String(rawChunk));
    originalBytes += chunk.length;

    if (retainedBytes < retainedLimit) {
      const retainedChunk = chunk.subarray(0, retainedLimit - retainedBytes);
      chunks.push(retainedChunk);
      retainedBytes += retainedChunk.length;
    }
  }

  return {
    buffer: Buffer.concat(chunks, retainedBytes),
    originalBytes,
    truncated: originalBytes > maxBytes,
  };
}

function replaceKnownSecrets(
  value: string,
  secrets: readonly string[],
): { text: string; redacted: boolean } {
  let text = value;
  let redacted = false;

  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      text = text.split(secret).join('[REDACTED]');
      redacted = true;
    }
  }

  const assignmentPattern =
    /\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*([=:])\s*([^\s,;]+)/gi;
  text = text.replace(assignmentPattern, (_match, name, separator) => {
    redacted = true;
    return String(name) + String(separator) + '[REDACTED]';
  });

  const jsonPattern =
    /(["'](?:[^"']*(?:key|token|secret|password|credential)[^"']*)["']\s*:\s*["'])[^"']*(["'])/gi;
  text = text.replace(jsonPattern, (_match, prefix, suffix) => {
    redacted = true;
    return String(prefix) + '[REDACTED]' + String(suffix);
  });

  return { text, redacted };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) {
    return value;
  }

  const marker = Buffer.from(TRUNCATION_MARKER);
  if (maxBytes <= marker.length) {
    return marker.subarray(0, maxBytes).toString('utf8');
  }

  const prefixBudget = maxBytes - marker.length;
  let prefixEnd = prefixBudget;
  while (prefixEnd > 0 && !isUtf8(encoded.subarray(0, prefixEnd))) {
    prefixEnd -= 1;
  }

  return encoded.subarray(0, prefixEnd).toString('utf8') + TRUNCATION_MARKER;
}

export function truncateAndRedactOutput(
  input: string | Buffer,
  options: OutputSanitizationOptions,
): CapturedOutput {
  assertPositiveInteger(
    options.maxBytes,
    'Output limit',
    MAX_OUTPUT_BYTES_PER_STREAM,
  );

  const source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const sanitized = replaceKnownSecrets(source, options.secrets ?? []);
  const originalBytes =
    options.originalBytes ??
    (Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input));
  const requiresTruncation =
    options.wasTruncated === true ||
    Buffer.byteLength(sanitized.text) > options.maxBytes;

  return {
    text: requiresTruncation
      ? truncateUtf8(sanitized.text, options.maxBytes)
      : sanitized.text,
    originalBytes,
    truncated: requiresTruncation,
    redacted: sanitized.redacted,
  };
}

export function terminateProcessTree(process: TerminableProcess): boolean {
  try {
    return process.kill('SIGTERM');
  } catch {
    return false;
  }
}

function emptyOutput(): CapturedOutput {
  return {
    text: '',
    originalBytes: 0,
    truncated: false,
    redacted: false,
  };
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function configurationError(
  startedAt: number,
  error: unknown,
): CommandExecutionResult {
  return {
    outcome: 'configuration_error',
    exitCode: null,
    signal: null,
    durationMs: Date.now() - startedAt,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    termination: {
      requested: null,
      accepted: false,
      guarantee: 'best_effort',
    },
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export async function executeCommand(
  spec: CommandSpec,
  options: ExecuteCommandOptions = {},
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const parentEnvironment = options.parentEnvironment ?? process.env;
  let prepared: PreparedCommand;

  if (isAbortRequested(options.signal)) {
    return {
      outcome: 'cancelled',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyOutput(),
      stderr: emptyOutput(),
      termination: {
        requested: 'cancelled',
        accepted: false,
        guarantee: 'best_effort',
      },
    };
  }

  try {
    prepared = await prepareCommand(spec, parentEnvironment);
  } catch (error) {
    if (error instanceof CommandSpawnError) {
      return {
        outcome: 'spawn_error',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: emptyOutput(),
        stderr: emptyOutput(),
        termination: {
          requested: null,
          accepted: false,
          guarantee: 'best_effort',
        },
        errorMessage: error.message,
      };
    }
    return configurationError(startedAt, error);
  }

  const subprocess = execa(prepared.executable, [...spec.args], {
    buffer: false,
    cleanup: true,
    cwd: prepared.cwd,
    env: prepared.environment,
    extendEnv: false,
    forceKillAfterDelay: 1_000,
    killDescendants: true,
    reject: false,
    shell: false,
    stdin: 'ignore',
    windowsHide: true,
  });

  let terminationReason: TerminationReason | null = null;
  let terminationAccepted = false;
  const requestTermination = (reason: TerminationReason): void => {
    if (terminationReason !== null) {
      return;
    }
    terminationReason = reason;
    terminationAccepted = terminateProcessTree(subprocess);
  };
  const timeout = setTimeout(() => requestTermination('timeout'), spec.timeoutMs);
  timeout.unref();
  const onAbort = (): void => requestTermination('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (isAbortRequested(options.signal)) {
    requestTermination('cancelled');
  }

  try {
    const stdoutCapture = captureStream(
      subprocess.stdout,
      spec.maxOutputBytesPerStream,
    );
    const stderrCapture = captureStream(
      subprocess.stderr,
      spec.maxOutputBytesPerStream,
    );
    const [result, rawStdout, rawStderr] = await Promise.all([
      subprocess,
      stdoutCapture,
      stderrCapture,
    ]);
    const stdout = truncateAndRedactOutput(rawStdout.buffer, {
      maxBytes: spec.maxOutputBytesPerStream,
      originalBytes: rawStdout.originalBytes,
      secrets: prepared.secrets,
      wasTruncated: rawStdout.truncated,
    });
    const stderr = truncateAndRedactOutput(rawStderr.buffer, {
      maxBytes: spec.maxOutputBytesPerStream,
      originalBytes: rawStderr.originalBytes,
      secrets: prepared.secrets,
      wasTruncated: rawStderr.truncated,
    });
    const outcome =
      terminationReason === 'timeout'
        ? 'timed_out'
        : terminationReason === 'cancelled'
          ? 'cancelled'
          : result.exitCode === 0
            ? 'succeeded'
            : result.exitCode === undefined
              ? 'spawn_error'
              : 'failed';

    return {
      outcome,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
      termination: {
        requested: terminationReason,
        accepted: terminationAccepted,
        guarantee: 'best_effort',
      },
      ...(outcome === 'spawn_error' && {
        errorMessage: result.shortMessage,
      }),
    };
  } catch (error) {
    return {
      outcome:
        terminationReason === 'timeout'
          ? 'timed_out'
          : terminationReason === 'cancelled'
            ? 'cancelled'
            : 'spawn_error',
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyOutput(),
      stderr: emptyOutput(),
      termination: {
        requested: terminationReason,
        accepted: terminationAccepted,
        guarantee: 'best_effort',
      },
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
