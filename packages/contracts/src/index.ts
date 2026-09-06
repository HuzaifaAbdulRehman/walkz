export type CommandOutcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'spawn_error'
  | 'configuration_error';

export type TerminationReason = 'timeout' | 'cancelled';

export interface CommandSpec {
  executable: string;
  args: readonly string[];
  repositoryRoot: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytesPerStream: number;
  inheritEnvironment?: readonly string[];
  environment?: Readonly<Record<string, string>>;
}
export interface CapturedOutput {
  text: string;
  originalBytes: number;
  truncated: boolean;
  redacted: boolean;
}

export interface CommandTermination {
  requested: TerminationReason | null;
  accepted: boolean;
  guarantee: 'best_effort';
}

export interface CommandExecutionResult {
  outcome: CommandOutcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  termination: CommandTermination;
  errorMessage?: string;
}
