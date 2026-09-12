import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitHubWebhookApi } from '../src/index.js';

const secret = 'webhook-secret';
const apps: Array<ReturnType<typeof createGitHubWebhookApi>> = [];

function signature(payload: string): string {
  return (
    'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
  );
}

const pullRequestPayload = {
  action: 'ready_for_review',
  installation: { id: 1234 },
  repository: { id: 5678, name: 'walkz', owner: { login: 'owner' } },
  pull_request: {
    id: 9012,
    number: 7,
    base: { sha: 'a'.repeat(40) },
    head: { sha: 'b'.repeat(40) },
  },
};

function createApi(outcome: 'queued' | 'duplicate' | 'ignored' = 'queued') {
  const result = outcome === 'queued'
    ? {
        status: 'queued' as const,
        reviewRunId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
        outboxEventIds: [
          '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
          '09e7392c-03bb-4b34-b099-0803fb0d9023',
        ] as [string, string],
        supersededRunIds: [],
      }
    : outcome === 'duplicate'
      ? { status: 'duplicate' as const }
      : { status: 'ignored' as const, reason: 'event_not_reviewable' as const };
  const intake = { accept: vi.fn().mockResolvedValue(result) };
  const app = createGitHubWebhookApi({
    secret,
    promptVersion: 'walkz-review-v1',
    intake,
  });
  apps.push(app);
  return { app, intake };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GitHub webhook boundary', () => {
  it('refuses an empty webhook secret', () => {
    expect(() =>
      createGitHubWebhookApi({
        secret: '',
        promptVersion: 'walkz-review-v1',
        intake: { accept: vi.fn() },
      }),
    ).toThrow('secret is required');
  });

  it('passes an exact pull request comment command to durable intake', async () => {
    const { app, intake } = createApi('ignored');
    intake.accept.mockResolvedValueOnce({
      status: 'command_queued',
      commandId: '0d6a37bd-ded7-4d24-ae90-ce10c016f974',
      outboxEventId: '21f369f4-a92f-46df-b0f5-5719d382436e',
    });
    const commandPayload = {
      action: 'created',
      installation: { id: 1234 },
      repository: { id: 5678, name: 'walkz', owner: { login: 'owner' } },
      issue: { number: 28, pull_request: { url: 'https://api.github.test/pulls/28' } },
      comment: {
        id: 9012,
        body: '@walkz-review review',
        user: { id: 3456, login: 'maintainer', type: 'User' },
      },
      sender: { id: 3456, login: 'maintainer', type: 'User' },
    };
    const payload = JSON.stringify(commandPayload);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-command',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, queued: true });
    expect(intake.accept).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-command',
      eventName: 'issue_comment',
      review: null,
      command: expect.objectContaining({
        command: 'review',
        commentId: '9012',
        commenterLogin: 'maintainer',
        pullRequestNumber: 28,
      }),
    }));
    const accepted = intake.accept.mock.calls[0]?.[0];
    expect(accepted).not.toHaveProperty('body');
    expect(JSON.stringify(accepted)).not.toContain('@walkz-review review');
  });

  it('passes a verified pull request to one atomic intake', async () => {
    const { app, intake } = createApi();
    const payload = JSON.stringify(pullRequestPayload);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, queued: true });
    expect(intake.accept).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      eventName: 'pull_request',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptVersion: 'walkz-review-v1',
      command: null,
      review: {
        trigger: 'ready_for_review',
        installationId: '1234',
        repositoryId: '5678',
        repositoryOwner: 'owner',
        repositoryName: 'walkz',
        pullRequestId: '9012',
        pullRequestNumber: 7,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
    });
  });

  it('rejects an invalid signature before parsing or storing payload data', async () => {
    const { app, intake } = createApi();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=invalid',
      },
      payload: '{not-json',
    });

    expect(response.statusCode).toBe(401);
    expect(intake.accept).not.toHaveBeenCalled();
  });

  it('rejects a signed malformed payload before storing it', async () => {
    const { app, intake } = createApi();
    const payload = '{not-json';

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-malformed',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(intake.accept).not.toHaveBeenCalled();
  });

  it('acknowledges duplicates without starting another review', async () => {
    const { app, intake } = createApi('duplicate');
    const payload = JSON.stringify(pullRequestPayload);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-3',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: false, queued: false });
    expect(intake.accept).toHaveBeenCalledOnce();
  });

  it('rejects a signed pull request with an invalid shape', async () => {
    const { app, intake } = createApi();
    const payload = JSON.stringify({ action: 'ready_for_review' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-invalid-shape',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_payload' });
    expect(intake.accept).not.toHaveBeenCalled();
  });

  it('records signed non-review events without queuing work', async () => {
    const { app, intake } = createApi('ignored');
    const payload = JSON.stringify({ zen: 'Keep it logically awesome.' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-ping',
        'x-github-event': 'ping',
        'x-hub-signature-256': signature(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, queued: false });
    expect(intake.accept).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'ping',
      review: null,
    }));
  });
});
