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

function createApi(outcome: 'accepted' | 'duplicate' = 'accepted') {
  const deliveryStore = { record: vi.fn().mockResolvedValue(outcome) };
  const reviewRunStarter = { start: vi.fn().mockResolvedValue(undefined) };
  const app = createGitHubWebhookApi({
    secret,
    deliveryStore,
    reviewRunStarter,
  });
  apps.push(app);
  return { app, deliveryStore, reviewRunStarter };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GitHub webhook boundary', () => {
  it('refuses an empty webhook secret', () => {
    expect(() =>
      createGitHubWebhookApi({
        secret: '',
        deliveryStore: { record: vi.fn() },
        reviewRunStarter: { start: vi.fn() },
      }),
    ).toThrow('secret is required');
  });

  it('records a verified delivery and starts one pending review', async () => {
    const { app, deliveryStore, reviewRunStarter } = createApi();
    const payload = JSON.stringify({ action: 'opened' });

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
    expect(deliveryStore.record).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      eventName: 'pull_request',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reviewRunStarter.start).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      eventName: 'pull_request',
    });
  });

  it('rejects an invalid signature before parsing or storing payload data', async () => {
    const { app, deliveryStore, reviewRunStarter } = createApi();

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
    expect(deliveryStore.record).not.toHaveBeenCalled();
    expect(reviewRunStarter.start).not.toHaveBeenCalled();
  });

  it('rejects a signed malformed payload before storing it', async () => {
    const { app, deliveryStore, reviewRunStarter } = createApi();
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
    expect(deliveryStore.record).not.toHaveBeenCalled();
    expect(reviewRunStarter.start).not.toHaveBeenCalled();
  });

  it('acknowledges duplicates without starting another review', async () => {
    const { app, deliveryStore, reviewRunStarter } = createApi('duplicate');
    const payload = JSON.stringify({ action: 'opened' });

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
    expect(response.json()).toEqual({ accepted: false });
    expect(deliveryStore.record).toHaveBeenCalledOnce();
    expect(reviewRunStarter.start).not.toHaveBeenCalled();
  });
});
