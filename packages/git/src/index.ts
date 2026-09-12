export { collectChangedFiles } from './changes.js';
export type { CollectChangedFilesOptions } from './changes.js';
export {
  buildDiffLineIndex,
  collectUnifiedDiff,
} from './diff.js';
export { collectReviewContext } from './context.js';
export { loadRepositoryGuidance } from './guidance.js';
export {
  GitCommandError,
  GitOutputLimitError,
} from './process.js';
export { resolveGitReferences } from './references.js';
export { locateRepositoryRoot } from './repository.js';
export { withHostedGitHubCheckout } from './hosted-checkout.js';
export type {
  HostedCheckoutOptions,
  HostedGitRunner,
} from './hosted-checkout.js';
export { readRepositoryFileAtRevision } from './revision-file.js';
export {
  assertProofWorkspacePath,
  assertProofWorkspacePaths,
  withProofWorkspaces,
} from './proof-workspace.js';
export { calculateChangeRisk } from './risk.js';
export type { CollectReviewContextOptions } from './context.js';
export type { CollectUnifiedDiffOptions } from './diff.js';
export type { LoadRepositoryGuidanceOptions } from './guidance.js';
export type {
  ProofWorkspace,
  ProofGitRunner,
  ProofWorkspaceLimits,
  ProofWorkspacePair,
  WithProofWorkspacesOptions,
} from './proof-workspace.js';
export type { ResolveGitReferencesOptions } from './references.js';
export type {
  ChangedFile,
  ChangedFileKind,
  ChangedFileStatus,
  ChangeRisk,
  CoverageOmission,
  CoverageOmissionReason,
  DiffLineIndex,
  GitComparisonMode,
  RepositoryGuidance,
  RepositoryGuidanceDocument,
  RepositoryGuidanceOmission,
  ResolvedGitReferences,
  ReviewContext,
  ReviewContextCoverage,
  UnifiedDiffCollection,
} from './types.js';
