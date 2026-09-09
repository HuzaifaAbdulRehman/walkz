import { z } from 'zod';

import type { GitHubInstallationApp } from './octokit-checks.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  { message: 'Installation ID must be a safe JavaScript integer.' },
);
const targetSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
}).strict();
const pullRequestSchema = z.object({
  id: githubIdSchema,
  number: z.number().int().positive(),
  state: z.literal('open'),
  draft: z.boolean(),
  base: z.object({
    sha: shaSchema,
    repo: z.object({
      id: githubIdSchema,
      name: z.string().trim().min(1).max(100),
      owner: z.object({ login: z.string().trim().min(1).max(100) }),
    }),
  }),
  head: z.object({ sha: shaSchema }),
}).refine((pullRequest) => pullRequest.base.sha !== pullRequest.head.sha, {
  message: 'Pull requests must compare different base and head commits.',
  path: ['head', 'sha'],
});

export interface GitHubPullRequest {
  githubId: string;
  number: number;
  repositoryGitHubId: string;
  repositoryOwner: string;
  repositoryName: string;
  baseSha: string;
  headSha: string;
  draft: boolean;
}

export interface InstallationPullRequestReader {
  get(target: unknown, pullRequestNumber: unknown): Promise<GitHubPullRequest>;
}

export interface InstallationPullRequestReaderFactory {
  forInstallation(installationId: string): Promise<InstallationPullRequestReader>;
}

export function createInstallationPullRequestReaderFactory(
  app: Pick<GitHubInstallationApp, 'getInstallationOctokit'>,
): InstallationPullRequestReaderFactory {
  return {
    async forInstallation(installationIdInput) {
      const installationId = installationIdSchema.parse(installationIdInput);
      const client = await app.getInstallationOctokit(Number(installationId));
      return {
        async get(targetInput, pullRequestNumberInput) {
          const target = targetSchema.parse(targetInput);
          const pullRequestNumber = z.number().int().positive().parse(
            pullRequestNumberInput,
          );
          const response = await client.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            {
              owner: target.owner,
              repo: target.repository,
              pull_number: pullRequestNumber,
            },
          );
          const pullRequest = pullRequestSchema.parse(response.data);
          if (
            pullRequest.base.repo.owner.login.toLowerCase() !==
              target.owner.toLowerCase() ||
            pullRequest.base.repo.name.toLowerCase() !==
              target.repository.toLowerCase()
          ) {
            throw new Error('GitHub returned a pull request for another repository.');
          }
          return {
            githubId: String(pullRequest.id),
            number: pullRequest.number,
            repositoryGitHubId: String(pullRequest.base.repo.id),
            repositoryOwner: pullRequest.base.repo.owner.login,
            repositoryName: pullRequest.base.repo.name,
            baseSha: pullRequest.base.sha,
            headSha: pullRequest.head.sha,
            draft: pullRequest.draft,
          };
        },
      };
    },
  };
}
