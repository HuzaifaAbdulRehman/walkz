import type {
  Finding,
  PatchFixJob,
  PatchProposal,
  ProviderAdapter,
  RepositoryConfig,
} from '@walkz/contracts';

import { generatePatchCandidate, type GeneratedPatchCandidate } from './patch-generation.js';
import { bindPatchProofToRepositoryCommand } from './patch-proof-binding.js';

export type PatchProposalPreparationFailureCode =
  | 'proof_binding_invalid'
  | 'provider_credential_required';

export class PatchProposalPreparationError extends Error {
  readonly code: PatchProposalPreparationFailureCode;

  constructor(code: PatchProposalPreparationFailureCode, message: string) {
    super(message);
    this.name = 'PatchProposalPreparationError';
    this.code = code;
  }
}

export interface VerifiedPatchProposalSource {
  repositoryId: string;
  installationId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  reviewRunId: string;
  findingId: string;
  baseSha: string;
  headSha: string;
  config: RepositoryConfig;
  provider: string;
  model: string;
  finding: Finding;
  proof: {
    planDigest: string;
    commandDigest: string;
  };
}

export interface PreparedPatchProposal {
  generated: GeneratedPatchCandidate;
  created: boolean;
  proposal: PatchProposal;
  job: PatchFixJob;
}

export interface PreparePatchProposalDependencies {
  loadCredential(input: {
    repositoryId: string;
    provider: string;
  }): Promise<string | null>;
  loadHeadFile(input: {
    installationId: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    path: string;
  }): Promise<{ currentHeadSha: string; path: string; content: string }>;
  createProvider(apiKey: string): ProviderAdapter;
  createProposal(input: {
    proposal: {
      reviewRunId: string;
      findingId: string;
      baseSha: string;
      headSha: string;
      patchHash: string;
      deliveryMode: 'suggestion';
    };
    provider: string;
    model: string;
    promptVersion: string;
    proofPlanDigest: string;
    proofCommandDigest: string;
  }): Promise<{
    created: boolean;
    proposal: PatchProposal;
    job: PatchFixJob;
  }>;
}

export async function prepareVerifiedPatchProposal(
  source: VerifiedPatchProposalSource,
  proofImage: string,
  dependencies: PreparePatchProposalDependencies,
  signal?: AbortSignal,
): Promise<PreparedPatchProposal> {
  let binding;
  try {
    binding = bindPatchProofToRepositoryCommand({
      reviewRunId: source.reviewRunId,
      findingFingerprint: source.finding.fingerprint,
      baseSha: source.baseSha,
      headSha: source.headSha,
      commandDigest: source.proof.commandDigest,
      containerImage: proofImage,
      config: source.config,
    });
  } catch {
    throw new PatchProposalPreparationError(
      'proof_binding_invalid',
      'Verified proof cannot be bound to the repository command.',
    );
  }
  if (binding.planDigest !== source.proof.planDigest) {
    throw new PatchProposalPreparationError(
      'proof_binding_invalid',
      'Verified proof does not match its immutable plan.',
    );
  }
  const credential = await dependencies.loadCredential({
    repositoryId: source.repositoryId,
    provider: source.provider,
  });
  if (credential === null) {
    throw new PatchProposalPreparationError(
      'provider_credential_required',
      'A provider credential is required to prepare a patch proposal.',
    );
  }
  const headFile = await dependencies.loadHeadFile({
    installationId: source.installationId,
    owner: source.owner,
    repository: source.repository,
    pullRequestNumber: source.pullRequestNumber,
    headSha: source.headSha,
    path: source.finding.file,
  });
  const generated = await generatePatchCandidate({
    reviewRunId: source.reviewRunId,
    findingId: source.findingId,
    baseSha: source.baseSha,
    headSha: source.headSha,
    currentHeadSha: headFile.currentHeadSha,
    deliveryMode: 'suggestion',
    model: source.model,
    maxModelTokens: source.config.tokenBudget,
    finding: {
      path: source.finding.file,
      startLine: source.finding.line,
      endLine: source.finding.endLine ?? source.finding.line,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      claim: source.finding.claim,
      failureMechanism: source.finding.failureMechanism,
    },
    headFile: { path: headFile.path, content: headFile.content },
  }, { provider: dependencies.createProvider(credential), ...(signal === undefined ? {} : { signal }) });
  const created = await dependencies.createProposal({
    proposal: {
      reviewRunId: source.reviewRunId,
      findingId: source.findingId,
      baseSha: source.baseSha,
      headSha: source.headSha,
      patchHash: generated.candidate.patchHash,
      deliveryMode: 'suggestion',
    },
    provider: generated.provider,
    model: generated.model,
    promptVersion: generated.promptVersion,
    proofPlanDigest: binding.planDigest,
    proofCommandDigest: binding.plan.commandDigest,
  });
  return { generated, ...created };
}
