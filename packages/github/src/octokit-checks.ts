import { App, Octokit } from 'octokit';
import { z } from 'zod';

import {
  createReviewCheckPublisher,
  type GitHubChecksClient,
  type ReviewCheckPublisher,
} from './publisher.js';

const checkRunSchema = z.object({
  id: z.number().int().positive(),
  external_id: z.string().nullable(),
});
const checkRunListSchema = z.object({ check_runs: z.array(checkRunSchema) });
const checkRunResultSchema = z.object({ id: z.number().int().positive() });
const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  { message: 'Installation ID must be a safe JavaScript integer.' },
);

export interface OctokitRequestClient {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface GitHubInstallationApp {
  getInstallationOctokit(installationId: number): Promise<OctokitRequestClient>;
}

export interface InstallationReviewCheckPublisherFactory {
  forInstallation(installationId: string): Promise<ReviewCheckPublisher>;
}

const appConfigSchema = z.object({
  appId: z.union([
    z.string().trim().min(1).max(128),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ]),
  privateKey: z.string().trim().min(1).max(65_536),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
}).strict();

export function createGitHubInstallationApp(input: unknown): GitHubInstallationApp {
  const config = appConfigSchema.parse(input);
  const InstallationOctokit = Octokit.defaults({
    request: { timeout: config.requestTimeoutMs },
  });
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    Octokit: InstallationOctokit,
  });
  return {
    async getInstallationOctokit(installationId) {
      const octokit = await app.getInstallationOctokit(installationId);
      return {
        async request(route, parameters) {
          const response = await octokit.request(route, parameters);
          return { data: response.data };
        },
      };
    },
  };
}

function output(input: {
  summary: string;
  annotations: Parameters<GitHubChecksClient['create']>[0]['annotations'];
}) {
  return {
    title: 'Walkz / review',
    summary: input.summary,
    annotations: input.annotations.map((annotation) => ({
      path: annotation.path,
      start_line: annotation.startLine,
      end_line: annotation.endLine,
      annotation_level: annotation.level,
      message: annotation.message,
    })),
  };
}

export function createOctokitChecksClient(client: OctokitRequestClient): GitHubChecksClient {
  return {
    async findByExternalId(input) {
      const response = await client.request(
        'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
        {
          owner: input.owner,
          repo: input.repo,
          ref: input.headSha,
          check_name: input.name,
          filter: 'all',
          per_page: 100,
        },
      );
      const checkRuns = checkRunListSchema.parse(response.data).check_runs;
      return checkRuns.find((checkRun) => checkRun.external_id === input.externalId) ?? null;
    },
    async create(input) {
      const response = await client.request('POST /repos/{owner}/{repo}/check-runs', {
        owner: input.owner,
        repo: input.repo,
        name: input.name,
        head_sha: input.headSha,
        status: input.status,
        external_id: input.externalId,
        ...(input.conclusion === null ? {} : { conclusion: input.conclusion }),
        output: output(input),
      });
      return checkRunResultSchema.parse(response.data);
    },
    async update(input) {
      const response = await client.request(
        'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
        {
          owner: input.owner,
          repo: input.repo,
          check_run_id: input.checkRunId,
          name: input.name,
          status: input.status,
          ...(input.conclusion === null ? {} : { conclusion: input.conclusion }),
          output: output(input),
        },
      );
      return checkRunResultSchema.parse(response.data);
    },
  };
}

export function createInstallationReviewCheckPublisherFactory(
  app: GitHubInstallationApp,
): InstallationReviewCheckPublisherFactory {
  return {
    async forInstallation(installationIdInput) {
      const installationId = installationIdSchema.parse(installationIdInput);
      const octokit = await app.getInstallationOctokit(Number(installationId));
      return createReviewCheckPublisher(createOctokitChecksClient(octokit));
    },
  };
}

export function createGitHubAppCheckPublisherFactory(
  input: unknown,
): InstallationReviewCheckPublisherFactory {
  return createInstallationReviewCheckPublisherFactory(
    createGitHubInstallationApp(input),
  );
}
