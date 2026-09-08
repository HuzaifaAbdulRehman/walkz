import { z } from 'zod';

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string().min(1) }).nullable(),
}).strict();

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }).strict(),
}).strict();

export interface GitHubReadClient {
  getInstallation(installationId: string): Promise<{ id: string; accountLogin: string | null }>;
  listInstallationRepositories(installationId: string): Promise<Array<{ id: string; owner: string; name: string }>>;
}

export function createGitHubReadClient(
  token: string,
  fetcher: typeof fetch = fetch,
): GitHubReadClient {
  if (token.trim().length === 0) {
    throw new Error('GitHub access token is required.');
  }

  async function request(path: string): Promise<unknown> {
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with status ${response.status}.`);
    }
    return response.json();
  }

  return {
    async getInstallation(installationId) {
      const installation = installationSchema.parse(await request(`/app/installations/${installationId}`));
      return { id: String(installation.id), accountLogin: installation.account?.login ?? null };
    },
    async listInstallationRepositories(installationId) {
      const body = z.object({ repositories: z.array(repositorySchema) }).strict().parse(
        await request(`/user/installations/${installationId}/repositories`),
      );
      return body.repositories.map((repository) => ({
        id: String(repository.id),
        owner: repository.owner.login,
        name: repository.name,
      }));
    },
  };
}
