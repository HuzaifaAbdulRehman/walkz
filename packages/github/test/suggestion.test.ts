import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubSuggestionService,
  createInstallationGitHubSuggestionServiceFactory,
} from '../src/index.js';

const proposalId = '34e04c9f-bf3a-4ab9-9c81-902ad75d0110';
const headSha = 'b'.repeat(40);
const patchHash = 'c'.repeat(64);
const target = {
  owner: 'octocat',
  repository: 'walkz',
  pullRequestNumber: 7,
};
const suggestion = {
  ...target,
  proposalId,
  headSha,
  patchHash,
  path: 'src/value.ts',
  startLine: 2,
  endLine: 3,
  replacement: '  const value = `safe`;\n  return value;',
};

function pullRequest(sha = headSha) {
  return { data: { state: 'open', head: { sha } } };
}

function existingComment(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 321,
    body,
    html_url: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
    commit_id: headSha,
    path: suggestion.path,
    line: suggestion.endLine,
    start_line: suggestion.startLine,
    ...overrides,
  };
}

describe('GitHub patch suggestions', () => {
  it('loads a bounded file from the exact open pull request head', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce({
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('export const value = 1;\n').toString('base64'),
        },
      });
    const service = createGitHubSuggestionService({ request });

    await expect(service.loadHeadFile({
      ...target,
      headSha,
      path: suggestion.path,
    })).resolves.toEqual({
      currentHeadSha: headSha,
      path: suggestion.path,
      content: 'export const value = 1;\n',
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'GET /repos/{owner}/{repo}/contents/{path}',
      {
        owner: target.owner,
        repo: target.repository,
        path: suggestion.path,
        ref: headSha,
      },
    );
  });

  it('publishes one exact-head multiline suggestion without merge or contents writes', async () => {
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return pullRequest();
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return { data: [] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        expect(String(parameters.body)).toContain('```suggestion\n');
        expect(String(parameters.body)).toContain(
          `<!-- walkz-suggestion:${proposalId}:${patchHash} -->`,
        );
        return {
          data: {
            id: 321,
            html_url: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
          },
        };
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    const service = createGitHubSuggestionService({ request });

    await expect(service.publish(suggestion)).resolves.toEqual({
      commentId: '321',
      htmlUrl: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
      created: true,
    });
    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      expect.objectContaining({
        commit_id: headSha,
        path: suggestion.path,
        line: 3,
        side: 'RIGHT',
        start_line: 2,
        start_side: 'RIGHT',
      }),
    );
    expect(request.mock.calls.every(([route]) =>
      !String(route).includes('/merge') &&
      !(String(route).startsWith('PUT ') || String(route).startsWith('PATCH ')),
    )).toBe(true);
  });

  it('uses a longer Markdown fence when replacement text contains backticks', async () => {
    let body = '';
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return pullRequest();
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return { data: [] };
      }
      body = String(parameters.body);
      return {
        data: {
          id: 321,
          html_url: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
        },
      };
    });
    const service = createGitHubSuggestionService({ request });

    await service.publish({ ...suggestion, replacement: 'const text = ```;' });

    expect(body).toContain('````suggestion\nconst text = ```;\n````');
  });

  it('reuses an exact marked comment instead of creating a duplicate', async () => {
    let listedBody = '';
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return pullRequest();
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return { data: listedBody === '' ? [] : [existingComment(listedBody)] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        listedBody = String(parameters.body);
        throw new Error('connection reset after GitHub accepted the comment');
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    const service = createGitHubSuggestionService({ request });

    await expect(service.publish(suggestion)).resolves.toEqual({
      commentId: '321',
      htmlUrl: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
      created: false,
    });
    expect(request.mock.calls.filter(([route]) =>
      route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
    )).toHaveLength(1);
  });

  it('fails closed when a suggestion marker belongs to different content', async () => {
    const marker = `<!-- walkz-suggestion:${proposalId}:${patchHash} -->`;
    const request = vi.fn(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return pullRequest();
      }
      return { data: [existingComment(`different\n${marker}`)] };
    });
    const service = createGitHubSuggestionService({ request });

    await expect(service.publish(suggestion)).rejects.toMatchObject({
      code: 'marker_conflict',
    });
    expect(request.mock.calls.some(([route]) => String(route).startsWith('POST ')))
      .toBe(false);
  });

  it('removes its new comment if the head changes during publication', async () => {
    let headReads = 0;
    const request = vi.fn(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        headReads += 1;
        return pullRequest(headReads === 1 ? headSha : 'd'.repeat(40));
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return { data: [] };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return {
          data: {
            id: 321,
            html_url: 'https://github.com/octocat/walkz/pull/7#discussion_r321',
          },
        };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}') {
        return { data: null };
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    const service = createGitHubSuggestionService({ request });

    await expect(service.publish(suggestion)).rejects.toMatchObject({
      code: 'stale_head',
    });
    expect(request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}',
      { owner: target.owner, repo: target.repository, comment_id: 321 },
    );
  });

  it('creates an installation-scoped suggestion service', async () => {
    const request = vi.fn();
    const getInstallationOctokit = vi.fn().mockResolvedValue({ request });
    const factory = createInstallationGitHubSuggestionServiceFactory({
      getInstallationOctokit,
    });

    await expect(factory.forInstallation('123')).resolves.toBeDefined();
    expect(getInstallationOctokit).toHaveBeenCalledWith(123);
    await expect(factory.forInstallation('9007199254740992')).rejects.toThrow();
  });
});
