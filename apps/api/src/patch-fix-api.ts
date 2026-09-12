import type { FastifyInstance } from 'fastify';

import type { ProviderAdapter } from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  generatePatchCandidate,
  PatchGenerationError,
} from '@walkz/engine';
import type { InstallationGitHubSuggestionServiceFactory } from '@walkz/github';
import { SuggestionPublicationError } from '@walkz/github';
import type {
  CreatedPatchFixProposal,
  DecidedPatchFixProposal,
  PatchFixListItem,
  VerifiedPatchFixSource,
} from '@walkz/persistence';
import { createGroqProvider } from '@walkz/providers';
import { z } from 'zod';

const createParamsSchema = z.object({
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
}).strict();
const proposalParamsSchema = z.object({
  repositoryId: z.uuid(),
  proposalId: z.uuid(),
}).strict();
const reviewParamsSchema = z.object({
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
}).strict();
const decisionSchema = z.object({
  expectedPatchHash: z.string().regex(/^[a-f0-9]{64}$/i),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
  decision: z.enum(['approved', 'rejected']),
}).strict();

export interface PatchFixAuthenticator {
  authenticate(request: unknown): Promise<{
    userId: string;
    repositoryIds: readonly string[];
  } | null>;
}

export interface PatchFixStore {
  loadSource(input: {
    repositoryId: string;
    actorUserId: string;
    reviewRunId: string;
    findingId: string;
  }): Promise<VerifiedPatchFixSource | null>;
  loadCredential(input: {
    repositoryId: string;
    provider: string;
  }): Promise<string | null>;
  create(input: {
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
  }): Promise<CreatedPatchFixProposal>;
  decide(input: {
    repositoryId: string;
    actorUserId: string;
    proposalId: string;
    expectedPatchHash: string;
    expectedHeadSha: string;
    decision: 'approved' | 'rejected';
  }): Promise<DecidedPatchFixProposal>;
  list(input: {
    repositoryId: string;
    reviewRunId: string;
  }): Promise<PatchFixListItem[]>;
}

export interface PatchFixApiOptions {
  authenticator: PatchFixAuthenticator;
  store: PatchFixStore;
  github: InstallationGitHubSuggestionServiceFactory;
  proofImage: string;
  createProvider?: (apiKey: string) => ProviderAdapter;
}

function authorizedRepository(
  identity: { repositoryIds: readonly string[] },
  repositoryId: string,
): boolean {
  return identity.repositoryIds.includes(repositoryId);
}

function serializeFix(item: PatchFixListItem) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    completedAt: item.completedAt?.toISOString() ?? null,
  };
}

export function registerPatchFixRoutes(
  app: FastifyInstance,
  options: PatchFixApiOptions,
): void {
  const createProvider = options.createProvider ?? ((apiKey: string) =>
    createGroqProvider({ apiKey }));

  app.post(
    '/api/repositories/:repositoryId/reviews/:reviewRunId/findings/:findingId/patch-proposals',
    async (request, reply) => {
      const params = createParamsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!authorizedRepository(identity, params.repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const source = await options.store.loadSource({
        ...params,
        actorUserId: identity.userId,
      });
      if (source === null) {
        return reply.code(404).send({ error: 'verified_finding_not_found' });
      }
      let binding;
      try {
        binding = bindPatchProofToRepositoryCommand({
          reviewRunId: source.reviewRunId,
          findingFingerprint: source.finding.fingerprint,
          baseSha: source.baseSha,
          headSha: source.headSha,
          commandDigest: source.proof.commandDigest,
          containerImage: options.proofImage,
          config: source.config,
        });
      } catch {
        return reply.code(409).send({ error: 'proof_binding_invalid' });
      }
      if (binding.planDigest !== source.proof.planDigest) {
        return reply.code(409).send({ error: 'proof_binding_invalid' });
      }
      const credential = await options.store.loadCredential({
        repositoryId: source.repositoryId,
        provider: source.provider,
      });
      if (credential === null) {
        return reply.code(409).send({ error: 'provider_credential_required' });
      }
      try {
        const service = await options.github.forInstallation(source.installationId);
        const headFile = await service.loadHeadFile({
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
        }, { provider: createProvider(credential) });
        const created = await options.store.create({
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
        return reply.code(created.created ? 201 : 200).send({
          candidate: generated.candidate,
          proposal: created.proposal,
          job: created.job,
          created: created.created,
        });
      } catch (error) {
        if (error instanceof PatchGenerationError) {
          const status = error.code === 'stale_head' ? 409 :
            error.code === 'invalid_input' || error.code === 'invalid_response'
              ? 400
              : 503;
          return reply.code(status).send({
            error: error.code === 'stale_head'
              ? 'patch_proposal_stale'
              : status === 503
                ? 'patch_generation_unavailable'
                : 'invalid_patch_candidate',
          });
        }
        if (error instanceof SuggestionPublicationError) {
          return reply.code(error.code === 'stale_head' ? 409 : 502).send({
            error: error.code === 'stale_head'
              ? 'patch_proposal_stale'
              : 'github_source_unavailable',
          });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/repositories/:repositoryId/patch-proposals/:proposalId/decision',
    async (request, reply) => {
      const params = proposalParamsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!authorizedRepository(identity, params.repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const decision = decisionSchema.parse(request.body);
      const result = await options.store.decide({
        ...params,
        ...decision,
        actorUserId: identity.userId,
      });
      if (result.outcome === 'denied') {
        return reply.code(404).send({ error: 'patch_proposal_not_found' });
      }
      if (result.outcome === 'stale' || result.outcome === 'conflict') {
        return reply.code(409).send({
          error: result.outcome === 'stale'
            ? 'patch_proposal_stale'
            : 'patch_proposal_conflict',
        });
      }
      return reply.code(decision.decision === 'approved' ? 202 : 200).send({
        outcome: result.outcome,
        proposal: result.proposal,
        job: result.job,
      });
    },
  );

  app.get(
    '/api/repositories/:repositoryId/reviews/:reviewRunId/patch-fixes',
    async (request, reply) => {
      const params = reviewParamsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!authorizedRepository(identity, params.repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const fixes = await options.store.list(params);
      return reply.send({ fixes: fixes.map(serializeFix) });
    },
  );
}
