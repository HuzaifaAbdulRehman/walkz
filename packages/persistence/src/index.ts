export {
  createDatabasePool,
  databasePoolConfigSchema,
  parseDatabasePoolConfig,
} from './pool.js';

export type { DatabasePoolConfig } from './pool.js';

export { insertWebhookDelivery, recordWebhookDelivery } from './webhook-delivery.js';

export type { WebhookDeliveryInput } from './webhook-delivery.js';

export {
  claimOutboxEvent,
  createGitHubCheckCompletedOutboxEvent,
  createGitHubCheckQueuedOutboxEvent,
  createGitHubCommentCommandQueuedOutboxEvent,
  createOutboxEventStore,
  createPatchFixQueuedOutboxEvent,
  createReviewRunQueuedOutboxEvent,
  listRecoverableOutboxEventIds,
  markOutboxEventPublished,
  githubCheckCompletedOutboxEventSchema,
  githubCheckResultFindingSchema,
  githubCheckVerdictSchema,
  githubCheckQueuedOutboxEventSchema,
  githubCommentCommandQueuedOutboxEventSchema,
  patchFixQueuedOutboxEventSchema,
  reviewRunQueuedOutboxEventSchema,
  withTransaction,
} from './outbox.js';

export type {
  ClaimedOutboxEvent,
  GitHubCheckCompletedOutboxEvent,
  GitHubCheckQueuedOutboxEvent,
  GitHubCommentCommandQueuedOutboxEvent,
  OutboxEventLeaseInput,
  OutboxEventStore,
  PatchFixQueuedOutboxEvent,
  ReviewRunQueuedOutboxEvent,
} from './outbox.js';

export {
  createCredentialVault,
  credentialEncryptionConfigSchema,
  deleteProviderCredential,
  decryptCredential,
  encryptCredential,
  hasProviderCredential,
  loadProviderCredential,
  storeProviderCredential,
} from './credential-vault.js';

export type { CredentialVault, EncryptedCredential } from './credential-vault.js';

export {
  cancelReviewRun,
  supersedeActiveReviewRuns,
} from './review-run-control.js';

export {
  createQueuedReviewRun,
  createQueuedReviewRunInTransaction,
  queuedReviewRunSchema,
} from './review-run.js';

export type { CreatedQueuedReviewRun } from './review-run.js';

export { queueGitHubReviewRun } from './github-review-run.js';
export type { QueuedGitHubReviewRun } from './github-review-run.js';

export {
  getManualReviewRepository,
  queueManualReview,
} from './manual-review.js';
export type {
  ManualReviewInput,
  ManualReviewQueueResult,
  ManualReviewRepository,
} from './manual-review.js';

export { completeHostedReviewRun } from './review-result.js';
export type { CompletedHostedReviewRun } from './review-result.js';

export { acceptGitHubWebhook } from './github-review-intake.js';
export type {
  GitHubWebhookIntakeInput,
  GitHubWebhookIntakeResult,
} from './github-review-intake.js';

export {
  claimReviewCommentCommand,
  completeGitHubCommentCommand,
  failGitHubCommentCommand,
  listRecoverableReviewCommentCommandIds,
  releaseGitHubCommentCommand,
  renewGitHubCommentCommandLease,
} from './github-comment-command.js';
export type { ClaimedGitHubCommentCommand } from './github-comment-command.js';

export { purgeExpiredAuditEvents, recordAuditEvent } from './audit.js';

export {
  listRepositoryConfigVersions,
  saveRepositoryConfig,
} from './repository-config.js';
export type { RepositoryConfigVersion } from './repository-config.js';

export {
  listGrantedRepositories,
  selectGrantedRepository,
} from './repository-selection.js';
export type { GrantedRepository } from './repository-selection.js';

export {
  claimHostedReviewRun,
  listRecoverableHostedReviewRunIds,
  renewHostedReviewRunLease,
} from './hosted-review-worker.js';
export type { ClaimedHostedReviewRun } from './hosted-review-worker.js';

export { listReviewHistory } from './review-history.js';
export type { ReviewHistoryItem } from './review-history.js';

export { listReviewFindings } from './review-findings.js';
export type { ReviewFindingItem } from './review-findings.js';

export {
  createPatchProposal,
  createPatchProposalInTransaction,
  decidePatchProposal,
  decidePatchProposalInTransaction,
  preparePatchSuggestionPublication,
  recordPatchSuggestionPublication,
  releasePatchSuggestionPublication,
} from './patch-proposal.js';
export type {
  CreatedPatchProposal,
  PatchProposalDecisionOutcome,
  PatchProposalDecisionResult,
  PatchSuggestionPublicationOutcome,
  PatchSuggestionPublicationResult,
  PatchSuggestionPublicationTarget,
} from './patch-proposal.js';

export {
  getLatestPatchReproofResult,
  recordPatchReproofResult,
} from './patch-reproof.js';
export type {
  PatchReproofRecordOutcome,
  PatchReproofRecordResult,
} from './patch-reproof.js';

export {
  claimPatchFixJob,
  completePatchFixJob,
  createPatchFixProposal,
  decidePatchFixProposal,
  failPatchFixJob,
  getPatchFixJob,
  listPatchFixes,
  listRecoverablePatchFixProposalIds,
  releasePatchFixJob,
  renewPatchFixJobLease,
} from './patch-fix.js';
export type {
  CreatedPatchFixProposal,
  DecidedPatchFixProposal,
  PatchFixListItem,
} from './patch-fix.js';

export {
  loadClaimedPatchFixTarget,
  loadVerifiedPatchFixSource,
} from './patch-fix-target.js';
export type {
  ClaimedPatchFixTarget,
  PatchFixProofBinding,
  VerifiedPatchFixSource,
} from './patch-fix-target.js';

export {
  consumeOAuthState,
  createPersistentGitHubSessionService,
  purgeExpiredOAuthStates,
  purgeExpiredSessions,
  storeOAuthState,
} from './auth.js';
export type {
  GitHubIdentityResolver,
  PersistentGitHubSessionService,
  SessionPrincipal,
} from './auth.js';
