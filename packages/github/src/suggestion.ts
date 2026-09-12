import { Buffer } from 'node:buffer';

import { z } from 'zod';

import type {
  GitHubInstallationApp,
  OctokitRequestClient,
} from './octokit-checks.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const githubUrlSchema = z.url().max(512).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'github.com';
}, { message: 'GitHub references must use github.com HTTPS URLs.' });
const repositoryPathSchema = z.string().min(1).max(4_096).refine(
  (value) =>
    value === value.trim() &&
    !value.includes('\\') &&
    !/^(?:[A-Za-z]:|\/)/u.test(value) &&
    !/[\u0000-\u001F\u007F]/u.test(value) &&
    value.split('/').every(
      (segment) => segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        segment.toLowerCase() !== '.git',
    ),
  { message: 'Suggestion paths must be normalized repository-relative paths.' },
);
const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  { message: 'Installation ID must be a safe JavaScript integer.' },
);
const targetSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
}).strict();
const headFileRequestSchema = targetSchema.extend({
  headSha: shaSchema,
  path: repositoryPathSchema,
}).strict();
const suggestionRequestSchema = headFileRequestSchema.extend({
  proposalId: z.uuid(),
  patchHash: sha256Schema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  replacement: z.string().max(64 * 1_024).refine(
    (value) => !value.includes('\0') && !value.includes('\r'),
    { message: 'Suggestion replacements must use bounded LF text.' },
  ),
}).strict().refine((input) => input.endLine >= input.startLine, {
  message: 'Suggestion end line must not precede its start line.',
  path: ['endLine'],
});
const publishedSuggestionRequestSchema = targetSchema.extend({
  proposalId: z.uuid(),
  headSha: shaSchema,
  patchHash: sha256Schema,
  githubReference: githubUrlSchema,
}).strict();
const pullRequestSchema = z.object({
  state: z.literal('open'),
  head: z.object({ sha: shaSchema }),
});
const contentSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string().max(750_000),
}).passthrough();
const reviewCommentSchema = z.object({
  id: z.number().int().positive().safe(),
  body: z.string().max(65_000).nullable(),
  html_url: githubUrlSchema,
  commit_id: shaSchema,
  path: z.string(),
  line: z.number().int().positive().nullable(),
  start_line: z.number().int().positive().nullable().optional(),
}).passthrough();
const reviewCommentsSchema = z.array(reviewCommentSchema).max(100);
const createdCommentSchema = z.object({
  id: z.number().int().positive().safe(),
  html_url: githubUrlSchema,
}).passthrough();

const reviewCommentPageSize = 100;
const maximumReviewCommentPages = 20;
const maximumSuggestionBodyBytes = 65_000;
const maximumHeadFileBytes = 512 * 1_024;

export type SuggestionPublicationFailureCode =
  | 'invalid_input'
  | 'stale_head'
  | 'invalid_github_response'
  | 'marker_conflict'
  | 'comment_limit'
  | 'request_failed'
  | 'cleanup_failed';

export class SuggestionPublicationError extends Error {
  readonly code: SuggestionPublicationFailureCode;

  constructor(
    code: SuggestionPublicationFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SuggestionPublicationError';
    this.code = code;
  }
}

export interface GitHubHeadFile {
  currentHeadSha: string;
  path: string;
  content: string;
}

export interface PublishedSuggestion {
  commentId: string;
  htmlUrl: string;
  created: boolean;
}

export interface PublishedSuggestionContent {
  commentId: string;
  htmlUrl: string;
  headSha: string;
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface GitHubSuggestionService {
  loadHeadFile(input: unknown): Promise<GitHubHeadFile>;
  loadPublishedSuggestion(input: unknown): Promise<PublishedSuggestionContent>;
  publish(input: unknown): Promise<PublishedSuggestion>;
}

export interface InstallationGitHubSuggestionServiceFactory {
  forInstallation(installationId: string): Promise<GitHubSuggestionService>;
}

function publicationError(
  code: SuggestionPublicationFailureCode,
  message: string,
  cause?: unknown,
): SuggestionPublicationError {
  return new SuggestionPublicationError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw publicationError('invalid_input', 'GitHub suggestion input is invalid.', error);
  }
}

async function currentHead(
  client: OctokitRequestClient,
  target: z.infer<typeof targetSchema>,
): Promise<string> {
  let response;
  try {
    response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: target.owner,
      repo: target.repository,
      pull_number: target.pullRequestNumber,
    });
  } catch (error) {
    throw publicationError(
      'request_failed',
      'GitHub could not load the current pull request head.',
      error,
    );
  }
  try {
    return pullRequestSchema.parse(response.data).head.sha.toLowerCase();
  } catch (error) {
    throw publicationError(
      'invalid_github_response',
      'GitHub did not return an open pull request with an exact head.',
      error,
    );
  }
}

function decodeBase64File(input: unknown): string {
  let parsed;
  try {
    parsed = contentSchema.parse(input);
  } catch (error) {
    throw publicationError(
      'invalid_github_response',
      'GitHub did not return a regular base64 file.',
      error,
    );
  }
  const encoded = parsed.content.replace(/[\r\n]/gu, '');
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw publicationError(
      'invalid_github_response',
      'GitHub returned malformed base64 file content.',
    );
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > maximumHeadFileBytes) {
    throw publicationError(
      'invalid_github_response',
      'GitHub returned a file outside the patch publication limit.',
    );
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw publicationError(
      'invalid_github_response',
      'GitHub returned non-UTF-8 file content for a patch suggestion.',
      error,
    );
  }
  if (content.includes('\0')) {
    throw publicationError(
      'invalid_github_response',
      'GitHub returned binary content for a patch suggestion.',
    );
  }
  return content;
}

function suggestionFence(replacement: string): string {
  const longest = Math.max(
    0,
    ...Array.from(replacement.matchAll(/`+/gu), (match) => match[0].length),
  );
  return '`'.repeat(Math.max(3, longest + 1));
}

function buildSuggestionBody(input: z.infer<typeof suggestionRequestSchema>): {
  body: string;
  marker: string;
} {
  const marker = suggestionMarker(input.proposalId, input.patchHash);
  const fence = suggestionFence(input.replacement);
  const replacement = input.replacement.endsWith('\n')
    ? input.replacement
    : `${input.replacement}\n`;
  const body = [
    'Walkz prepared this change from verified evidence. Apply it only after review.',
    '',
    `${fence}suggestion`,
    replacement + fence,
    '',
    marker,
  ].join('\n');
  if (Buffer.byteLength(body, 'utf8') > maximumSuggestionBodyBytes) {
    throw publicationError(
      'invalid_input',
      'The rendered GitHub suggestion exceeds the safe comment limit.',
    );
  }
  return { body, marker };
}

function suggestionMarker(proposalId: string, patchHash: string): string {
  return `<!-- walkz-suggestion:${proposalId}:${patchHash.toLowerCase()} -->`;
}

function commentIdFromReference(
  reference: string,
  input: z.infer<typeof targetSchema>,
): number {
  const url = new URL(reference);
  const expectedPath = `/${input.owner}/${input.repository}/pull/${input.pullRequestNumber}`;
  const match = /^#discussion_r([1-9][0-9]*)$/u.exec(url.hash);
  const commentId = match === null ? Number.NaN : Number(match[1]);
  if (
    url.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    !Number.isSafeInteger(commentId)
  ) {
    throw publicationError(
      'invalid_input',
      'The stored GitHub reference does not identify this pull request suggestion.',
    );
  }
  return commentId;
}

function parseSuggestionReplacement(body: string, marker: string): string {
  const prefix =
    'Walkz prepared this change from verified evidence. Apply it only after review.\n\n';
  const markerSuffix = `\n\n${marker}`;
  if (!body.startsWith(prefix) || !body.endsWith(markerSuffix)) {
    throw publicationError(
      'marker_conflict',
      'The stored GitHub suggestion no longer matches its approved marker.',
    );
  }
  const content = body.slice(prefix.length, -markerSuffix.length);
  const firstLineEnd = content.indexOf('\n');
  if (firstLineEnd < 0) {
    throw publicationError('marker_conflict', 'The stored GitHub suggestion is malformed.');
  }
  const opening = content.slice(0, firstLineEnd);
  const match = /^(`{3,})suggestion$/u.exec(opening);
  if (match === null) {
    throw publicationError('marker_conflict', 'The stored GitHub suggestion is malformed.');
  }
  const closing = `\n${match[1]}`;
  if (!content.endsWith(closing)) {
    throw publicationError('marker_conflict', 'The stored GitHub suggestion is malformed.');
  }
  const replacement = content.slice(firstLineEnd + 1, -closing.length);
  if (
    replacement.includes('\0') ||
    replacement.includes('\r') ||
    Buffer.byteLength(replacement, 'utf8') > 64 * 1_024
  ) {
    throw publicationError(
      'marker_conflict',
      'The stored GitHub suggestion contains unsupported replacement text.',
    );
  }
  return replacement;
}

function matchesSuggestion(
  comment: z.infer<typeof reviewCommentSchema>,
  input: z.infer<typeof suggestionRequestSchema>,
  body: string,
): boolean {
  return comment.body === body &&
    comment.commit_id.toLowerCase() === input.headSha.toLowerCase() &&
    comment.path === input.path &&
    comment.line === input.endLine &&
    (input.startLine === input.endLine
      ? comment.start_line === null || comment.start_line === undefined
      : comment.start_line === input.startLine);
}

async function findExistingSuggestion(
  client: OctokitRequestClient,
  input: z.infer<typeof suggestionRequestSchema>,
  body: string,
  marker: string,
): Promise<PublishedSuggestion | null> {
  for (let page = 1; page <= maximumReviewCommentPages; page += 1) {
    let response;
    try {
      response = await client.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
        {
          owner: input.owner,
          repo: input.repository,
          pull_number: input.pullRequestNumber,
          per_page: reviewCommentPageSize,
          page,
        },
      );
    } catch (error) {
      throw publicationError(
        'request_failed',
        'GitHub review comments could not be checked for an earlier suggestion.',
        error,
      );
    }
    let comments;
    try {
      comments = reviewCommentsSchema.parse(response.data);
    } catch (error) {
      throw publicationError(
        'invalid_github_response',
        'GitHub returned invalid review comments.',
        error,
      );
    }
    for (const comment of comments) {
      if (comment.body?.includes(marker) !== true) continue;
      if (!matchesSuggestion(comment, input, body)) {
        throw publicationError(
          'marker_conflict',
          'A GitHub comment already uses this suggestion marker with different content.',
        );
      }
      return {
        commentId: String(comment.id),
        htmlUrl: comment.html_url,
        created: false,
      };
    }
    if (comments.length < reviewCommentPageSize) return null;
  }
  throw publicationError(
    'comment_limit',
    'GitHub review comment history exceeded the safe idempotency scan limit.',
  );
}

async function createSuggestion(
  client: OctokitRequestClient,
  input: z.infer<typeof suggestionRequestSchema>,
  body: string,
): Promise<PublishedSuggestion> {
  let response;
  try {
    response = await client.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      {
        owner: input.owner,
        repo: input.repository,
        pull_number: input.pullRequestNumber,
        body,
        commit_id: input.headSha,
        path: input.path,
        side: 'RIGHT',
        line: input.endLine,
        ...(input.startLine === input.endLine
          ? {}
          : { start_line: input.startLine, start_side: 'RIGHT' }),
      },
    );
  } catch (error) {
    throw publicationError(
      'request_failed',
      'GitHub did not confirm creation of the patch suggestion.',
      error,
    );
  }
  try {
    const comment = createdCommentSchema.parse(response.data);
    return {
      commentId: String(comment.id),
      htmlUrl: comment.html_url,
      created: true,
    };
  } catch (error) {
    throw publicationError(
      'invalid_github_response',
      'GitHub returned an invalid created review comment.',
      error,
    );
  }
}

async function deleteSuggestion(
  client: OctokitRequestClient,
  input: z.infer<typeof suggestionRequestSchema>,
  commentId: string,
): Promise<void> {
  try {
    await client.request('DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner: input.owner,
      repo: input.repository,
      comment_id: Number(commentId),
    });
  } catch (error) {
    throw publicationError(
      'cleanup_failed',
      'The pull request head changed and Walkz could not remove its stale suggestion.',
      error,
    );
  }
}

export function createGitHubSuggestionService(
  client: OctokitRequestClient,
): GitHubSuggestionService {
  return {
    async loadHeadFile(inputValue) {
      const input = parseInput(headFileRequestSchema, inputValue);
      const head = await currentHead(client, input);
      if (head !== input.headSha.toLowerCase()) {
        throw publicationError(
          'stale_head',
          'The pull request head changed before its source was loaded.',
        );
      }
      let response;
      try {
        response = await client.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: input.owner,
          repo: input.repository,
          path: input.path,
          ref: input.headSha,
        });
      } catch (error) {
        throw publicationError(
          'request_failed',
          'GitHub could not load the exact head file for patch publication.',
          error,
        );
      }
      return {
        currentHeadSha: head,
        path: input.path,
        content: decodeBase64File(response.data),
      };
    },

    async loadPublishedSuggestion(inputValue) {
      const input = parseInput(publishedSuggestionRequestSchema, inputValue);
      if (await currentHead(client, input) !== input.headSha.toLowerCase()) {
        throw publicationError(
          'stale_head',
          'The pull request head changed before the approved suggestion was loaded.',
        );
      }
      const commentId = commentIdFromReference(input.githubReference, input);
      let response;
      try {
        response = await client.request(
          'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}',
          {
            owner: input.owner,
            repo: input.repository,
            comment_id: commentId,
          },
        );
      } catch (error) {
        throw publicationError(
          'request_failed',
          'GitHub could not load the approved patch suggestion.',
          error,
        );
      }
      let comment;
      try {
        comment = reviewCommentSchema.parse(response.data);
      } catch (error) {
        throw publicationError(
          'invalid_github_response',
          'GitHub returned an invalid approved patch suggestion.',
          error,
        );
      }
      const marker = suggestionMarker(input.proposalId, input.patchHash);
      if (
        comment.body === null ||
        comment.html_url !== input.githubReference ||
        comment.commit_id.toLowerCase() !== input.headSha.toLowerCase() ||
        comment.line === null
      ) {
        throw publicationError(
          'marker_conflict',
          'The stored GitHub suggestion is not bound to the approved proposal.',
        );
      }
      let path;
      try {
        path = repositoryPathSchema.parse(comment.path);
      } catch (error) {
        throw publicationError(
          'marker_conflict',
          'The stored GitHub suggestion path is invalid.',
          error,
        );
      }
      const startLine = comment.start_line ?? comment.line;
      return {
        commentId: String(comment.id),
        htmlUrl: comment.html_url,
        headSha: comment.commit_id.toLowerCase(),
        path,
        startLine,
        endLine: comment.line,
        replacement: parseSuggestionReplacement(comment.body, marker),
      };
    },

    async publish(inputValue) {
      const input = parseInput(suggestionRequestSchema, inputValue);
      const { body, marker } = buildSuggestionBody(input);
      if (await currentHead(client, input) !== input.headSha.toLowerCase()) {
        throw publicationError(
          'stale_head',
          'The pull request head changed before suggestion publication.',
        );
      }

      let published = await findExistingSuggestion(client, input, body, marker);
      if (published === null) {
        try {
          published = await createSuggestion(client, input, body);
        } catch (error) {
          if (
            error instanceof SuggestionPublicationError &&
            error.code === 'request_failed'
          ) {
            const recovered = await findExistingSuggestion(client, input, body, marker);
            if (recovered === null) throw error;
            published = recovered;
          } else {
            throw error;
          }
        }
      }

      if (await currentHead(client, input) !== input.headSha.toLowerCase()) {
        if (published.created) {
          await deleteSuggestion(client, input, published.commentId);
        }
        throw publicationError(
          'stale_head',
          'The pull request head changed while the suggestion was published.',
        );
      }
      return published;
    },
  };
}

export function createInstallationGitHubSuggestionServiceFactory(
  app: Pick<GitHubInstallationApp, 'getInstallationOctokit'>,
): InstallationGitHubSuggestionServiceFactory {
  return {
    async forInstallation(installationIdInput) {
      const installationId = installationIdSchema.parse(installationIdInput);
      const client = await app.getInstallationOctokit(Number(installationId));
      return createGitHubSuggestionService(client);
    },
  };
}
