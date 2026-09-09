import { z } from 'zod';

const githubIdSchema = z.number().int().positive().safe();
const tokenResponseSchema = z.object({
  access_token: z.string().trim().min(1).max(1_024),
  token_type: z.string().trim().min(1).max(64),
});
const userSchema = z.object({
  id: githubIdSchema,
  login: z.string().trim().min(1).max(100),
});
const permissionSchema = z.enum(['read', 'write']);
const installationSchema = z.object({
  id: githubIdSchema,
  account: z.object({ login: z.string().trim().min(1).max(100) }),
  permissions: z.record(z.string(), permissionSchema),
});
const installationsSchema = z.object({
  installations: z.array(installationSchema).max(100),
});
const repositorySchema = z.object({
  id: githubIdSchema,
  name: z.string().trim().min(1).max(100),
  owner: z.object({ login: z.string().trim().min(1).max(100) }),
});
const repositoriesSchema = z.object({
  repositories: z.array(repositorySchema).max(100),
});

const responseLimitBytes = 1_024 * 1_024;
const githubApiVersion = '2022-11-28';
const installationPageSize = 100;
const repositoryPageSize = 100;
const maximumInstallationCount = 100;
const maximumRepositoryPages = 10;
const discoveryConcurrency = 4;

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > responseLimitBytes) {
    throw new Error('GitHub returned an oversized response.');
  }
  return JSON.parse(text) as unknown;
}

function githubHeaders(accessToken?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': githubApiVersion,
    ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
  };
}

export interface GitHubOAuthClient {
  exchangeCode(code: string): Promise<{ accessToken: string }>;
}

export interface GitHubUserInstallation {
  installationId: string;
  accountLogin: string;
  repositories: Array<{ githubId: string; owner: string; name: string }>;
}

export interface GitHubUserIdentity {
  githubId: string;
  login: string;
  installations: GitHubUserInstallation[];
}

export interface GitHubUserIdentityClient {
  load(accessToken: string): Promise<GitHubUserIdentity>;
}

export function createGitHubOAuthClient(options: {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): GitHubOAuthClient {
  const clientId = z.string().trim().min(1).max(256).parse(options.clientId);
  const clientSecret = z.string().trim().min(1).max(1_024).parse(options.clientSecret);
  const callbackUrl = z.url().parse(options.callbackUrl);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = z.number().int().min(100).max(60_000).parse(options.timeoutMs ?? 10_000);
  return {
    async exchangeCode(codeInput) {
      const code = z.string().trim().min(1).max(1_024).parse(codeInput);
      const response = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { ...githubHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`GitHub OAuth exchange failed with status ${response.status}.`);
      }
      const token = tokenResponseSchema.parse(await readBoundedJson(response));
      return { accessToken: token.access_token };
    },
  };
}

export function createGitHubUserIdentityClient(
  fetcher: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): GitHubUserIdentityClient {
  const timeoutMs = z.number().int().min(100).max(60_000).parse(options.timeoutMs ?? 10_000);
  return {
    async load(accessTokenInput) {
      const accessToken = z.string().trim().min(1).max(1_024).parse(accessTokenInput);
      const headers = githubHeaders(accessToken);
      const request = (url: string) => fetcher(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const userRequest = fetcher('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const installationsRequest = (async () => {
        const firstResponse = await request(
          `https://api.github.com/user/installations?per_page=${installationPageSize}&page=1`,
        );
        if (!firstResponse.ok) throw new Error('GitHub identity lookup failed.');
        const first = installationsSchema.parse(await readBoundedJson(firstResponse)).installations;
        if (first.length < maximumInstallationCount) return first;
        const overflowResponse = await request(
          `https://api.github.com/user/installations?per_page=1&page=${maximumInstallationCount + 1}`,
        );
        if (!overflowResponse.ok) throw new Error('GitHub identity lookup failed.');
        const overflow = installationsSchema.parse(await readBoundedJson(overflowResponse)).installations;
        if (overflow.length > 0) {
          throw new Error('GitHub installation discovery exceeded its safe limit.');
        }
        return first;
      })();
      const [userResponse, installations] = await Promise.all([userRequest, installationsRequest]);
      if (!userResponse.ok) {
        throw new Error('GitHub identity lookup failed.');
      }
      const user = userSchema.parse(await readBoundedJson(userResponse));
      const mappedInstallations: GitHubUserInstallation[] = new Array(installations.length);
      let nextInstallation = 0;
      await Promise.all(Array.from(
        { length: Math.min(discoveryConcurrency, installations.length) },
        async () => {
          while (nextInstallation < installations.length) {
            const index = nextInstallation;
            nextInstallation += 1;
            const installation = installations[index];
            if (installation === undefined) return;
        if (
          installation.permissions.metadata !== 'read' ||
          installation.permissions.contents !== 'read' ||
          installation.permissions.pull_requests !== 'read' ||
          installation.permissions.checks !== 'write' ||
          installation.permissions.issues !== 'read'
        ) {
          throw new Error('GitHub installation permissions exceed the Walkz boundary.');
        }
            const repositories: Array<{ githubId: string; owner: string; name: string }> = [];
            for (let page = 1; page <= maximumRepositoryPages; page += 1) {
              const response = await request(
                `https://api.github.com/user/installations/${installation.id}/repositories?per_page=${repositoryPageSize}&page=${page}`,
              );
              if (!response.ok) throw new Error('GitHub repository access lookup failed.');
              const body = repositoriesSchema.parse(await readBoundedJson(response));
              repositories.push(...body.repositories.map((repository) => ({
                githubId: String(repository.id),
                owner: repository.owner.login,
                name: repository.name,
              })));
              if (body.repositories.length < repositoryPageSize) break;
              if (page === maximumRepositoryPages) {
                throw new Error('GitHub repository discovery exceeded its safe page limit.');
              }
            }
            mappedInstallations[index] = {
              installationId: String(installation.id),
              accountLogin: installation.account.login,
              repositories,
            };
          }
        },
      ));
      return { githubId: String(user.id), login: user.login, installations: mappedInstallations };
    },
  };
}
