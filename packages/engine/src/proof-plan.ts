import { createHash } from 'node:crypto';

import {
  parseProofPlan,
  proofCommandSchema,
  type LocalReviewBudget,
  type ProofCommand,
  type ProofPlan,
  type ProofResourceLimits,
} from '@walkz/contracts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface ProofFileInput {
  path: string;
  content: string | Uint8Array;
}

export interface CreateProofPlanInput {
  runId: string;
  findingFingerprint: string;
  baseSha: string;
  headSha: string;
  containerImage: string;
  command: ProofCommand;
  files?: readonly ProofFileInput[];
  limits: ProofResourceLimits;
}

export interface ProofPlanAuthorization {
  authorizedCommandDigests: ReadonlySet<string>;
}

export interface ProofBudget {
  maxAttempts: number;
  maxTotalDurationMs: number;
  maxAttemptDurationMs: number;
  maxOutputBytesPerStream: number;
  maxArtifactBytes: number;
  deadlineMs: number;
}

export type ProofBudgetExhaustionReason =
  | 'attempts_exhausted'
  | 'deadline_reached'
  | 'duration_exhausted';

export type ProofBudgetAllocation =
  | { status: 'available'; budget: ProofBudget }
  | { status: 'exhausted'; reason: ProofBudgetExhaustionReason };

export interface AllocateProofBudgetOptions {
  attemptsUsed?: number;
  maxTotalDurationMs?: number;
  maxAttemptDurationMs?: number;
  maxOutputBytesPerStream?: number;
  maxArtifactBytes?: number;
}

const DEFAULT_PROOF_BUDGET = {
  maxTotalDurationMs: 120_000,
  maxAttemptDurationMs: 30_000,
  maxOutputBytesPerStream: 64 * 1_024,
  maxArtifactBytes: 16 * 1_024 * 1_024,
} as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('Proof digest input contains an unsupported value.');
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  return (
    '{' +
    Object.entries(value)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(
        ([key, entry]) =>
          JSON.stringify(key) + ':' + canonicalJson(entry),
      )
      .join(',') +
    '}'
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateBudgetInteger(
  value: number,
  name: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(name + ' must be a safe integer of at least ' + minimum + '.');
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Proof file content must use canonical base64.');
  }
  return decoded;
}

function assertProofPlanIntegrity(plan: ProofPlan): number {
  if (digestProofCommand(plan.command) !== plan.commandDigest) {
    throw new Error('Proof command digest does not match the command.');
  }

  let totalFileBytes = 0;
  for (const file of plan.files) {
    const content = decodeCanonicalBase64(file.contentBase64);
    if (sha256(content) !== file.sha256.toLowerCase()) {
      throw new Error('Proof file digest does not match its content.');
    }
    totalFileBytes += content.byteLength;
  }
  if (totalFileBytes > plan.limits.maxWritableBytes) {
    throw new Error('Proof files exceed the writable-byte limit.');
  }
  return totalFileBytes;
}

function assertAuthorized(
  commandDigest: string,
  authorization: ProofPlanAuthorization,
): void {
  let approved = false;
  for (const digest of authorization.authorizedCommandDigests) {
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error('Authorized command digests must be SHA-256 values.');
    }
    if (digest.toLowerCase() === commandDigest.toLowerCase()) {
      approved = true;
    }
  }
  if (!approved) {
    throw new Error('Proof command has not been approved.');
  }
}

function assertPlanFitsBudget(
  plan: ProofPlan,
  fileBytes: number,
  budget: ProofBudget,
): void {
  validateBudgetInteger(budget.maxAttempts, 'maxAttempts', 1);
  validateBudgetInteger(
    budget.maxTotalDurationMs,
    'maxTotalDurationMs',
    100,
  );
  validateBudgetInteger(
    budget.maxAttemptDurationMs,
    'maxAttemptDurationMs',
    100,
  );
  validateBudgetInteger(
    budget.maxOutputBytesPerStream,
    'maxOutputBytesPerStream',
    1_024,
  );
  validateBudgetInteger(
    budget.maxArtifactBytes,
    'maxArtifactBytes',
    1024 * 1_024,
  );
  validateBudgetInteger(budget.deadlineMs, 'deadlineMs', 0);
  if (budget.maxAttemptDurationMs > budget.maxTotalDurationMs) {
    throw new Error('Proof attempt budget exceeds the total proof budget.');
  }
  if (plan.limits.timeoutMs > budget.maxAttemptDurationMs) {
    throw new Error('Proof timeout exceeds the allocated attempt budget.');
  }
  if (
    plan.limits.maxOutputBytesPerStream >
    budget.maxOutputBytesPerStream
  ) {
    throw new Error('Proof output limit exceeds the allocated budget.');
  }
  if (
    plan.limits.maxWritableBytes > budget.maxArtifactBytes ||
    fileBytes > budget.maxArtifactBytes
  ) {
    throw new Error('Proof writable limit exceeds the artifact budget.');
  }
}

export function digestProofCommand(commandInput: unknown): string {
  const command = proofCommandSchema.parse(commandInput);
  return sha256(canonicalJson(command));
}

export function createProofPlan(
  input: CreateProofPlanInput,
  authorization: ProofPlanAuthorization,
  budget: ProofBudget,
): ProofPlan {
  const commandDigest = digestProofCommand(input.command);
  assertAuthorized(commandDigest, authorization);
  const files = (input.files ?? []).map((file) => {
    const content = Buffer.from(file.content);
    return {
      path: file.path,
      contentBase64: content.toString('base64'),
      sha256: sha256(content),
    };
  });
  const plan = parseProofPlan({
    schemaVersion: 1,
    runId: input.runId,
    findingFingerprint: input.findingFingerprint,
    baseSha: input.baseSha,
    headSha: input.headSha,
    containerImage: input.containerImage,
    isolation: {
      network: 'none',
      readOnlyRootFilesystem: true,
      dropCapabilities: 'all',
      noNewPrivileges: true,
    },
    command: input.command,
    commandDigest,
    files,
    limits: input.limits,
  });
  const fileBytes = assertProofPlanIntegrity(plan);
  assertPlanFitsBudget(plan, fileBytes, budget);
  return plan;
}

export function verifyProofPlan(
  input: unknown,
  authorization: ProofPlanAuthorization,
  budget: ProofBudget,
): ProofPlan {
  const plan = parseProofPlan(input);
  const fileBytes = assertProofPlanIntegrity(plan);
  assertAuthorized(plan.commandDigest, authorization);
  assertPlanFitsBudget(plan, fileBytes, budget);
  return plan;
}

export function fingerprintProofPlan(input: unknown): string {
  const plan = parseProofPlan(input);
  assertProofPlanIntegrity(plan);
  return sha256(canonicalJson(plan));
}

export function allocateProofBudget(
  reviewBudget: LocalReviewBudget,
  nowMs = Date.now(),
  options: AllocateProofBudgetOptions = {},
): ProofBudgetAllocation {
  validateBudgetInteger(nowMs, 'Proof budget start time', 0);
  validateBudgetInteger(
    reviewBudget.maxProofAttempts,
    'Review proof-attempt budget',
    0,
  );
  validateBudgetInteger(reviewBudget.deadlineMs, 'Review deadline', 0);
  const attemptsUsed = options.attemptsUsed ?? 0;
  validateBudgetInteger(attemptsUsed, 'Used proof attempts', 0);
  const maxAttempts = reviewBudget.maxProofAttempts - attemptsUsed;
  if (maxAttempts <= 0) {
    return { status: 'exhausted', reason: 'attempts_exhausted' };
  }

  const remainingDurationMs = reviewBudget.deadlineMs - nowMs;
  if (remainingDurationMs <= 0) {
    return { status: 'exhausted', reason: 'deadline_reached' };
  }

  const configured = {
    maxTotalDurationMs:
      options.maxTotalDurationMs ??
      DEFAULT_PROOF_BUDGET.maxTotalDurationMs,
    maxAttemptDurationMs:
      options.maxAttemptDurationMs ??
      DEFAULT_PROOF_BUDGET.maxAttemptDurationMs,
    maxOutputBytesPerStream:
      options.maxOutputBytesPerStream ??
      DEFAULT_PROOF_BUDGET.maxOutputBytesPerStream,
    maxArtifactBytes:
      options.maxArtifactBytes ?? DEFAULT_PROOF_BUDGET.maxArtifactBytes,
  };
  validateBudgetInteger(
    configured.maxTotalDurationMs,
    'maxTotalDurationMs',
    100,
  );
  validateBudgetInteger(
    configured.maxAttemptDurationMs,
    'maxAttemptDurationMs',
    100,
  );
  validateBudgetInteger(
    configured.maxOutputBytesPerStream,
    'maxOutputBytesPerStream',
    1_024,
  );
  validateBudgetInteger(
    configured.maxArtifactBytes,
    'maxArtifactBytes',
    1024 * 1_024,
  );

  const maxTotalDurationMs = Math.min(
    remainingDurationMs,
    configured.maxTotalDurationMs,
  );
  if (maxTotalDurationMs < 100) {
    return { status: 'exhausted', reason: 'duration_exhausted' };
  }
  return {
    status: 'available',
    budget: {
      maxAttempts,
      maxTotalDurationMs,
      maxAttemptDurationMs: Math.min(
        configured.maxAttemptDurationMs,
        maxTotalDurationMs,
      ),
      maxOutputBytesPerStream: configured.maxOutputBytesPerStream,
      maxArtifactBytes: configured.maxArtifactBytes,
      deadlineMs: reviewBudget.deadlineMs,
    },
  };
}
