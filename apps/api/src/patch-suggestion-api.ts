import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import { patchCandidateSchema, type PatchProposal } from '@walkz/contracts';
import {
  PatchGenerationError,
  PatchPublicationError,
  prepareApprovedPatchSuggestion,
  verifyPatchCandidateIntegrity,
} from '@walkz/engine';
import type {
  InstallationGitHubSuggestionServiceFactory,
} from '@walkz/github';
import { SuggestionPublicationError } from '@walkz/github';
import type {
  PatchSuggestionPublicationResult,
} from '@walkz/persistence';
import { z } from 'zod';

const paramsSchema = z.object({
  repositoryId: z.uuid(),
  proposalId: z.uuid(),
}).strict();
const bodySchema = z.object({ candidate: patchCandidateSchema }).strict();

export interface PatchSuggestionAuthenticator {
  authenticate(request: unknown): Promise<{
    userId: string;
    repositoryIds: readonly string[];
  } | null>;
}

interface PatchSuggestionStoreInput {
  repositoryId: string;
  actorUserId: string;
  proposalId: string;
  expectedPatchHash: string;
  expectedHeadSha: string;
}

export interface PatchSuggestionStore {
  prepare(input: PatchSuggestionStoreInput & {
    publicationLeaseOwner: string;
    publicationLeaseMs: number;
  }): Promise<PatchSuggestionPublicationResult>;
  record(input: PatchSuggestionStoreInput & {
    githubReferenceValue: string;
    publicationLeaseOwner: string;
  }): Promise<PatchSuggestionPublicationResult>;
  release(input: {
    proposalId: string;
    publicationLeaseOwner: string;
  }): Promise<boolean>;
}

export interface PatchSuggestionPublisher {
  publish(input: {
    repositoryId: string;
    actorUserId: string;
    proposalId: string;
    candidate: unknown;
  }): Promise<{
    outcome: Exclude<PatchSuggestionPublicationResult['outcome'], 'ready'>;
    reference: string | null;
    created: boolean;
  }>;
}

export interface PatchSuggestionApiOptions {
  authenticator: PatchSuggestionAuthenticator;
  publisher: PatchSuggestionPublisher;
}

export class PatchSuggestionWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchSuggestionWorkflowError';
  }
}

function storedReference(proposal: PatchProposal): string | null {
  return proposal.githubReference?.kind === 'review_comment'
    ? proposal.githubReference.value
    : null;
}

export function createPatchSuggestionPublisher(
  store: PatchSuggestionStore,
  github: InstallationGitHubSuggestionServiceFactory,
): PatchSuggestionPublisher {
  return {
    async publish(input) {
      const candidate = verifyPatchCandidateIntegrity(input.candidate);
      if (candidate.deliveryMode !== 'suggestion') {
        return { outcome: 'conflict', reference: null, created: false };
      }
      const expected = {
        repositoryId: input.repositoryId,
        actorUserId: input.actorUserId,
        proposalId: input.proposalId,
        expectedPatchHash: candidate.patchHash,
        expectedHeadSha: candidate.headSha,
      };
      const publicationLeaseOwner = randomUUID();
      const publication = await store.prepare({
        ...expected,
        publicationLeaseOwner,
        publicationLeaseMs: 2 * 60_000,
      });
      if (publication.outcome === 'published' && publication.target !== null) {
        return {
          outcome: 'published',
          reference: storedReference(publication.target.proposal),
          created: false,
        };
      }
      if (publication.outcome !== 'ready' || publication.target === null) {
        return {
          outcome: publication.outcome === 'ready'
            ? 'conflict'
            : publication.outcome,
          reference: publication.target === null
            ? null
            : storedReference(publication.target.proposal),
          created: false,
        };
      }

      const target = publication.target;
      try {
        const service = await github.forInstallation(target.installationId);
        const remote = await service.loadHeadFile({
          owner: target.owner,
          repository: target.repository,
          pullRequestNumber: target.pullRequestNumber,
          headSha: candidate.headSha,
          path: candidate.path,
        });
        const prepared = prepareApprovedPatchSuggestion({
          candidate,
          proposal: target.proposal,
          currentHeadSha: remote.currentHeadSha,
          headFile: { path: remote.path, content: remote.content },
        });
        const published = await service.publish({
          owner: target.owner,
          repository: target.repository,
          pullRequestNumber: target.pullRequestNumber,
          proposalId: prepared.proposalId,
          headSha: prepared.headSha,
          patchHash: prepared.patchHash,
          path: prepared.path,
          startLine: prepared.startLine,
          endLine: prepared.endLine,
          replacement: prepared.replacement,
        });
        const recorded = await store.record({
          ...expected,
          publicationLeaseOwner,
          githubReferenceValue: published.htmlUrl,
        });
        const result = {
          outcome: recorded.outcome === 'ready' ? 'conflict' : recorded.outcome,
          reference: recorded.target === null
            ? published.htmlUrl
            : storedReference(recorded.target.proposal) ?? published.htmlUrl,
          created: published.created,
        };
        await store.release({ proposalId: input.proposalId, publicationLeaseOwner });
        return result;
      } catch (error) {
        try {
          await store.release({ proposalId: input.proposalId, publicationLeaseOwner });
        } catch {
          throw new PatchSuggestionWorkflowError(
            'Patch publication failed and its lease could not be released.',
          );
        }
        throw error;
      }
    },
  };
}

export function registerPatchSuggestionRoutes(
  app: FastifyInstance,
  options: PatchSuggestionApiOptions,
): void {
  app.post(
    '/api/repositories/:repositoryId/patch-proposals/:proposalId/publish-suggestion',
    async (request, reply) => {
      const { repositoryId, proposalId } = paramsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!identity.repositoryIds.includes(repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const { candidate } = bodySchema.parse(request.body);
      let result;
      try {
        result = await options.publisher.publish({
          repositoryId,
          actorUserId: identity.userId,
          proposalId,
          candidate,
        });
      } catch (error) {
        if (error instanceof PatchGenerationError) {
          return reply.code(400).send({ error: 'invalid_patch_candidate' });
        }
        if (error instanceof PatchPublicationError) {
          return reply.code(error.code === 'stale_head' ? 409 : 400).send({
            error: error.code === 'stale_head'
              ? 'patch_proposal_stale'
              : 'invalid_patch_candidate',
          });
        }
        if (error instanceof SuggestionPublicationError) {
          if (error.code === 'stale_head' || error.code === 'marker_conflict') {
            return reply.code(409).send({
              error: error.code === 'stale_head'
                ? 'patch_proposal_stale'
                : 'patch_publication_conflict',
            });
          }
          if (error.code === 'invalid_input') {
            return reply.code(400).send({ error: 'invalid_patch_candidate' });
          }
          request.log.warn(
            { publicationFailureCode: error.code },
            'GitHub suggestion publication failed',
          );
          return reply.code(502).send({ error: 'github_publication_failed' });
        }
        if (error instanceof PatchSuggestionWorkflowError) {
          request.log.error(
            { publicationFailureCode: 'lease_release_failed' },
            'Patch suggestion workflow failed',
          );
          return reply.code(503).send({ error: 'patch_publication_unavailable' });
        }
        throw error;
      }
      if (result.outcome === 'denied') {
        return reply.code(404).send({ error: 'patch_proposal_not_found' });
      }
      if (
        result.outcome === 'busy' ||
        result.outcome === 'conflict' ||
        result.outcome === 'stale'
      ) {
        return reply.code(409).send({
          error: result.outcome === 'busy'
            ? 'patch_publication_busy'
            : result.outcome === 'stale'
              ? 'patch_proposal_stale'
              : 'patch_proposal_conflict',
          ...(result.reference === null ? {} : { reference: result.reference }),
        });
      }
      return reply.send({
        status: 'published',
        reference: result.reference,
        created: result.created,
      });
    },
  );
}

export function createPatchSuggestionApi(
  options: PatchSuggestionApiOptions,
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerPatchSuggestionRoutes(app, options);
  return app;
}
