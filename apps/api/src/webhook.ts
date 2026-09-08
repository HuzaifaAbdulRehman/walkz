import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

export interface WebhookDeliveryStore {
  record(input: {
    deliveryId: string;
    eventName: string;
    payloadHash: string;
  }): Promise<'accepted' | 'duplicate'>;
}

export interface PendingReviewRunStarter {
  start(input: { deliveryId: string; eventName: string }): Promise<void>;
}

export interface GitHubWebhookApiOptions {
  secret: string;
  deliveryStore: WebhookDeliveryStore;
  reviewRunStarter: PendingReviewRunStarter;
}

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function verifyGitHubWebhookSignature(
  payload: Buffer,
  signature: string | null,
  secret: string,
): boolean {
  if (signature === null || !signature.startsWith('sha256=')) {
    return false;
  }
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(payload).digest('hex'),
  );
  const received = Buffer.from(signature);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function createGitHubWebhookApi(options: GitHubWebhookApiOptions) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post('/webhooks/github', async (request, reply) => {
    const payload = request.body as Buffer;
    const signature = headerValue(request.headers['x-hub-signature-256']);
    if (!verifyGitHubWebhookSignature(payload, signature, options.secret)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const deliveryId = headerValue(request.headers['x-github-delivery']);
    const eventName = headerValue(request.headers['x-github-event']);
    if (deliveryId === null || eventName === null) {
      return reply.code(400).send({ error: 'missing_delivery_metadata' });
    }

    try {
      JSON.parse(payload.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid_payload' });
    }

    const outcome = await options.deliveryStore.record({
      deliveryId,
      eventName,
      payloadHash: createHash('sha256').update(payload).digest('hex'),
    });
    if (outcome === 'accepted') {
      await options.reviewRunStarter.start({ deliveryId, eventName });
    }
    return reply.code(202).send({ accepted: outcome === 'accepted' });
  });
  return app;
}
