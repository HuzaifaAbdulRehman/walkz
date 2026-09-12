import type {
  InstallationGitHubCommentCommandClientFactory,
  InstallationPullRequestReaderFactory,
} from '@walkz/github';
import type {
  ClaimedGitHubCommentCommand,
  ManualReviewInput,
} from '@walkz/persistence';
import { z } from 'zod';

import type { CommentCommandJobHandler } from './comment-command-queue.js';

const optionsSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
  promptVersion: z.string().trim().min(1).max(128),
  dashboardUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username.length === 0 && url.password.length === 0 &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search.length === 0 && url.hash.length === 0;
  }, 'Dashboard URL must be an HTTPS origin without credentials.'),
}).strict();

interface CommentCommandLease {
  commandId: string;
  workerId: string;
  leaseMs: number;
}

export interface GitHubCommentCommandStore {
  claim(input: CommentCommandLease): Promise<ClaimedGitHubCommentCommand | null>;
  renew(input: CommentCommandLease): Promise<boolean>;
  queueReview(input: ManualReviewInput): Promise<{ reviewRunId: string }>;
  complete(input: {
    commandId: string;
    workerId: string;
    status: 'completed' | 'denied' | 'ignored';
    replyUrl: string;
    reviewRunId: string | null;
    patchProposalId: string | null;
  }): Promise<boolean>;
  release(input: { commandId: string; workerId: string }): Promise<boolean>;
  fail(input: {
    commandId: string;
    workerId: string;
    replyUrl?: string;
  }): Promise<boolean>;
}

export interface GitHubCommentCommandHandlerOptions {
  store: GitHubCommentCommandStore;
  comments: InstallationGitHubCommentCommandClientFactory;
  pullRequests: InstallationPullRequestReaderFactory;
  proposals: {
    prepare(
      command: ClaimedGitHubCommentCommand,
      signal: AbortSignal,
    ): Promise<{
      proposalId: string;
      reviewRunId: string;
      headSha: string;
    } | null>;
  };
  workerId: string;
  leaseMs: number;
  promptVersion: string;
  dashboardUrl: string;
}

function dashboardReviewUrl(baseUrl: string, reviewRunId: string): string {
  const url = new URL(baseUrl);
  url.hash = `review-${reviewRunId}`;
  return url.toString();
}

function startLeaseHeartbeat(
  store: GitHubCommentCommandStore,
  lease: CommentCommandLease,
  controller: AbortController,
): { stop(): Promise<boolean> } {
  const intervalMs = Math.max(1_000, Math.floor(lease.leaseMs / 3));
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const schedule = (): void => {
    timer = setTimeout(() => {
      pending = store.renew(lease)
        .then((renewed) => {
          if (!renewed) {
            lost = true;
            controller.abort();
          }
        })
        .catch(() => {
          lost = true;
          controller.abort();
        })
        .finally(() => {
          if (!stopped) schedule();
        });
      pending.catch(() => undefined);
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await pending;
      return !lost;
    },
  };
}

export function createGitHubCommentCommandJobHandler(
  input: GitHubCommentCommandHandlerOptions,
): CommentCommandJobHandler {
  const options = optionsSchema.parse({
    workerId: input.workerId,
    leaseMs: input.leaseMs,
    promptVersion: input.promptVersion,
    dashboardUrl: input.dashboardUrl,
  });
  return {
    async handle(commandId) {
      const lease = { commandId, workerId: options.workerId, leaseMs: options.leaseMs };
      const command = await input.store.claim(lease);
      if (command === null) return;
      const controller = new AbortController();
      const heartbeat = startLeaseHeartbeat(input.store, lease, controller);
      let completion: {
        status: 'completed' | 'denied' | 'ignored';
        replyUrl: string;
        reviewRunId: string | null;
        patchProposalId: string | null;
      } | null = null;
      let failureReplyUrl: string | undefined;
      let retry = false;
      try {
        const comments = await input.comments.forInstallation(command.installationId);
        const authorized = await comments.canMaintain({
          owner: command.owner,
          repository: command.repository,
          username: command.commenterLogin,
        });
        if (!authorized) {
          const reply = await comments.publishReply({
            owner: command.owner,
            repository: command.repository,
            pullRequestNumber: command.pullRequestNumber,
            commandCommentId: command.commentId,
            kind: 'denied',
            summary: 'Walkz did not run this command because its author does not currently have write access to this repository.',
          });
          completion = {
            status: 'denied',
            replyUrl: reply.url,
            reviewRunId: null,
            patchProposalId: null,
          };
        } else if (command.command === 'review') {
          const reader = await input.pullRequests.forInstallation(command.installationId);
          const pullRequest = await reader.get(
            { owner: command.owner, repository: command.repository },
            command.pullRequestNumber,
          );
          if (
            pullRequest.number !== command.pullRequestNumber ||
            pullRequest.repositoryGitHubId !== command.repositoryGitHubId
          ) {
            throw new Error('GitHub pull request does not match the command repository.');
          }
          const queued = await input.store.queueReview({
            requestId: command.commandId,
            repositoryId: command.repositoryId,
            installationId: command.installationId,
            githubId: command.repositoryGitHubId,
            owner: pullRequest.repositoryOwner,
            repository: pullRequest.repositoryName,
            pullRequestId: pullRequest.githubId,
            pullRequestNumber: pullRequest.number,
            baseSha: pullRequest.baseSha,
            headSha: pullRequest.headSha,
            promptVersion: options.promptVersion,
          });
          const reply = await comments.publishReply({
            owner: command.owner,
            repository: command.repository,
            pullRequestNumber: command.pullRequestNumber,
            commandCommentId: command.commentId,
            kind: 'queued',
            summary: `Walkz queued review ${queued.reviewRunId} for head \`${pullRequest.headSha.slice(0, 7)}\`.`,
          });
          completion = {
            status: 'completed',
            replyUrl: reply.url,
            reviewRunId: queued.reviewRunId,
            patchProposalId: null,
          };
        } else {
          let proposal;
          if (command.patchProposalId === null) {
            proposal = await input.proposals.prepare(command, controller.signal);
          } else {
            if (command.proposalReviewRunId === null || command.proposalHeadSha === null) {
              throw new Error('Linked proposal metadata is incomplete.');
            }
            proposal = {
              proposalId: command.patchProposalId,
              reviewRunId: command.proposalReviewRunId,
              headSha: command.proposalHeadSha,
            };
          }
          if (proposal === null) {
            const reply = await comments.publishReply({
              owner: command.owner,
              repository: command.repository,
              pullRequestNumber: command.pullRequestNumber,
              commandCommentId: command.commentId,
              kind: 'ignored',
              summary: 'Walkz found no current verified finding that is eligible for a fix proposal.',
            });
            completion = {
              status: 'ignored',
              replyUrl: reply.url,
              reviewRunId: null,
              patchProposalId: null,
            };
          } else {
            const link = dashboardReviewUrl(options.dashboardUrl, proposal.reviewRunId);
            const reply = await comments.publishReply({
              owner: command.owner,
              repository: command.repository,
              pullRequestNumber: command.pullRequestNumber,
              commandCommentId: command.commentId,
              kind: 'proposal',
              summary: `Walkz prepared proposal ${proposal.proposalId} for head \`${proposal.headSha.slice(0, 7)}\`. [Review and approve it in the Walkz dashboard](${link}).`,
            });
            completion = {
              status: 'completed',
              replyUrl: reply.url,
              reviewRunId: null,
              patchProposalId: proposal.proposalId,
            };
          }
        }
      } catch {
        if (controller.signal.aborted || command.attempt < 5) {
          retry = true;
        } else {
          try {
            const comments = await input.comments.forInstallation(command.installationId);
            const reply = await comments.publishReply({
              owner: command.owner,
              repository: command.repository,
              pullRequestNumber: command.pullRequestNumber,
              commandCommentId: command.commentId,
              kind: 'error',
              summary: 'Walkz could not complete this command after several attempts. Run it again later.',
            });
            failureReplyUrl = reply.url;
          } catch {
            failureReplyUrl = undefined;
          }
        }
      } finally {
        const heartbeatOwned = await heartbeat.stop();
        const leaseOwned = heartbeatOwned && await input.store.renew(lease);
        if (!leaseOwned) {
          retry = true;
        } else if (completion !== null) {
          const completed = await input.store.complete({
            commandId,
            workerId: options.workerId,
            ...completion,
          });
          if (!completed) retry = true;
        } else if (retry) {
          await input.store.release({ commandId, workerId: options.workerId });
        } else {
          const failed = await input.store.fail({
            commandId,
            workerId: options.workerId,
            ...(failureReplyUrl === undefined ? {} : { replyUrl: failureReplyUrl }),
          });
          if (!failed) retry = true;
        }
      }
      if (retry) throw new Error('GitHub comment command will be retried.');
    },
  };
}
