import type {
  EvidenceLevel,
  RepositoryConfig,
} from './config.js';
import type {
  ModelFinding,
  ReviewRequest,
} from './review.js';

export type ReviewVerdict =
  | 'SHIP'
  | 'FIX'
  | 'HUMAN'
  | 'INCONCLUSIVE'
  | 'ERROR';

export type ReviewLifecycleStatus =
  | 'queued'
  | 'collecting_context'
  | 'deterministic_checks'
  | 'reviewing'
  | 'challenging'
  | 'proving'
  | 'awaiting_human'
  | 'fixing'
  | 'reproving'
  | 'completed'
  | 'inconclusive'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type FindingLifecycleStatus =
  | 'proposed'
  | 'challenged'
  | 'proving'
  | 'verified'
  | 'supported'
  | 'unverified'
  | 'dismissed'
  | 'fixed';

export type EvidenceKind = 'deterministic_check' | 'counterfactual_proof';

export interface Evidence {
  kind: EvidenceKind;
  commandDigest: string;
  baseOutcome: string | null;
  headOutcome: string;
  baseExitCode: number | null;
  headExitCode: number | null;
  durationMs: number;
  sanitizedSummary: string;
  artifactHashes: string[];
  recordedAt: string;
}

export interface Finding {
  fingerprint: string;
  category: ModelFinding['category'];
  severity: ModelFinding['severity'];
  file: string;
  line: number;
  endLine?: number;
  claim: string;
  failureMechanism: string;
  suggestedProof: string;
  lifecycleStatus: FindingLifecycleStatus;
  evidenceLevel: EvidenceLevel;
  advisoryConfidence: number;
  evidence: Evidence[];
  dismissal: { reason: string; recordedAt: string } | null;
  fix: { patchHash: string; recordedAt: string } | null;
}

export interface LocalReviewBudget {
  maxDurationMs: number;
  maxModelTokens: number;
  maxProofAttempts: number;
  deadlineMs: number;
}

export interface LocalReviewRun {
  runId: string;
  request: ReviewRequest;
  config: RepositoryConfig;
  status: ReviewLifecycleStatus;
  verdict: ReviewVerdict | null;
  findings: Finding[];
  startedAt: string;
  completedAt: string | null;
}
