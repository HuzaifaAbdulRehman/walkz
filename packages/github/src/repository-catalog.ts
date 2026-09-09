import { z } from 'zod';

import type { GitHubInstallationApp } from './octokit-checks.js';

const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  { message: 'Installation ID must be a safe JavaScript integer.' },
);
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().trim().min(1).max(100),
  owner: z.object({ login: z.string().trim().min(1).max(100) }).strict(),
}).strict();
const responseSchema = z.object({
  repositories: z.array(repositorySchema).max(100),
}).passthrough();

const pageSize = 100;
const maximumPages = 10;

export interface InstallationRepository {
  githubId: string;
  owner: string;
  name: string;
}

export interface InstallationRepositoryCatalog {
  list(): Promise<InstallationRepository[]>;
}

export interface InstallationRepositoryCatalogFactory {
  forInstallation(installationId: string): Promise<InstallationRepositoryCatalog>;
}

export function createInstallationRepositoryCatalogFactory(
  app: GitHubInstallationApp,
): InstallationRepositoryCatalogFactory {
  return {
    async forInstallation(installationIdInput) {
      const installationId = installationIdSchema.parse(installationIdInput);
      const client = await app.getInstallationOctokit(Number(installationId));
      return {
        async list() {
          const repositories: InstallationRepository[] = [];
          for (let page = 1; page <= maximumPages; page += 1) {
            const response = await client.request('GET /installation/repositories', {
              per_page: pageSize,
              page,
            });
            const parsed = responseSchema.parse(response.data).repositories;
            repositories.push(...parsed.map((repository) => ({
              githubId: String(repository.id),
              owner: repository.owner.login,
              name: repository.name,
            })));
            if (parsed.length < pageSize) return repositories;
          }
          throw new Error('GitHub repository discovery exceeded its safe page limit.');
        },
      };
    },
  };
}
