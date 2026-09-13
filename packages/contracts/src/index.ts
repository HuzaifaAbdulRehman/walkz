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

export type CommandApprovalStatus =
  | 'approved'
  | 'declined'
  | 'unavailable'
  | 'not_required';

export interface CommandApprovalDecision {
  status: CommandApprovalStatus;
  source: 'trusted_config' | 'user' | 'none';
}

export interface DeterministicCheckResult {
  commandId: string;
  required: boolean;
  command: CommandSpec;
  execution: CommandExecutionResult;
}

export interface DeterministicCheckRun {
  approval: CommandApprovalDecision;
  plannedCount: number;
  checks: DeterministicCheckResult[];
  status: 'complete' | 'incomplete' | 'error';
}

export {
  modelPatchResponseSchema,
  parseModelPatchResponse,
  parsePatchCandidate,
  patchCandidateSchema,
  patchPathSchema,
} from './patch-generation.js';
export type {
  ModelPatchResponse,
  PatchCandidate,
} from './patch-generation.js';
export {
  approvedCommandSchema,
  createDefaultWalkzConfig,
  evidenceLevelSchema,
  mergeCliOverrides,
  parseWalkzConfig,
  repositoryConfigSchema,
} from './config.js';

export type {
  ApprovedCommand,
  EvidenceLevel,
  RepositoryConfig,
  WalkzCliOverrides,
} from './config.js';

export {
  modelFindingSchema,
  modelReviewResponseSchema,
  parseModelReviewResponse,
  reviewRequestSchema,
  validateReviewRequest,
} from './review.js';

export type {
  ModelFinding,
  ModelReviewResponse,
  ReviewRequest,
} from './review.js';

export type {
  ProviderAccessResult,
  ProviderAdapter,
  ProviderModel,
  ProviderName,
  ProviderRateLimit,
  ProviderRequestOptions,
  ProviderUsage,
  StructuredReviewRequest,
  StructuredReviewResult,
  StructuredPatchRequest,
  StructuredPatchResult,
} from './provider.js';

export {
  modelInvocationEventSchema,
  modelInvocationStageSchema,
  modelInvocationStatusSchema,
  parseModelInvocationEvent,
} from './model-invocation.js';

export type {
  ModelInvocationEvent,
  ModelInvocationStage,
  ModelInvocationStatus,
} from './model-invocation.js';

export {
  findingFeedbackAssessmentSchema,
  findingFeedbackReasonSchema,
  findingFeedbackRequestSchema,
  parseFindingFeedbackRequest,
} from './finding-feedback.js';
export type {
  FindingFeedbackAssessment,
  FindingFeedbackReason,
  FindingFeedbackRequest,
} from './finding-feedback.js';

export type {
  Evidence,
  EvidenceKind,
  Finding,
  FindingLifecycleStatus,
  LocalReviewBudget,
  LocalReviewRun,
  LocalVerdictDecision,
  LocalVerdictInput,
  OptionalStepStatus,
  RequiredStepStatus,
  ReviewLifecycleStatus,
  ReviewVerdict,
  VerdictReason,
} from './engine.js';

export {
  parseProofExecutionResult,
  parseProofPlan,
  proofArtifactSchema,
  proofCommandSchema,
  proofExecutionResultSchema,
  proofFileSchema,
  proofPlanSchema,
  proofResourceLimitsSchema,
  sanitizedProofOutputSchema,
} from './proof.js';

export type {
  ProofArtifact,
  ProofCommand,
  ProofExecutionResult,
  ProofFile,
  ProofPlan,
  ProofResourceLimits,
  SanitizedProofOutput,
} from './proof.js';

export {
  goldenProofClassificationSchema,
  goldenProofExpectationSchema,
  goldenProofFixtureManifestSchema,
  goldenProofRecordSchema,
  goldenProofRecordsSchema,
  parseGoldenProofFixtureManifest,
  parseGoldenProofRecords,
} from './golden.js';

export type {
  GoldenProofClassification,
  GoldenProofExpectation,
  GoldenProofFixtureManifest,
  GoldenProofRecord,
} from './golden.js';

export {
  canTransitionReviewRun,
  isTerminalReviewRunStatus,
  parseGithubId,
  parseHostedReviewRun,
  hostedReviewRunSchema,
  reviewRunStatusSchema,
} from './hosted.js';

export type {
  GithubId,
  HostedReviewRun,
  ReviewRunStatus,
} from './hosted.js';

export {
  canTransitionPatchApproval,
  isPatchProposalActionable,
  parsePatchApprovalRequest,
  parsePatchProposal,
  patchApprovalRequestSchema,
  patchApprovalStatusSchema,
  patchDeliveryModeSchema,
  patchGithubReferenceSchema,
  patchProposalSchema,
} from './patch.js';

export type {
  PatchApprovalRequest,
  PatchApprovalStatus,
  PatchDeliveryMode,
  PatchGithubReference,
  PatchProposal,
} from './patch.js';

export {
  patchFixFailureCodeSchema,
  patchFixJobSchema,
  patchFixStatusSchema,
  parsePatchFixJob,
} from './patch-fix.js';
export type {
  PatchFixFailureCode,
  PatchFixJob,
  PatchFixStatus,
} from './patch-fix.js';

export {
  parsePatchReproofResult,
  patchReproofCheckSchema,
  patchReproofResultSchema,
} from './reproof.js';
export type {
  PatchReproofCheck,
  PatchReproofResult,
} from './reproof.js';
