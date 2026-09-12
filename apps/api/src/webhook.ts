import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import {
  parsePullRequestCommentCommand,
  parsePullRequestReviewTrigger,
} from '@walkz/github';
import {
  acceptGitHubWebhook,
  type GitHubWebhookIntakeInput,
  type GitHubWebhookIntakeResult,
} from '@walkz/persistence';

export interface GitHubWebhookIntake {
  accept(input: GitHubWebhookIntakeInput): Promise<GitHubWebhookIntakeResult>;
}

export function createPersistentGitHubWebhookIntake(
  pool: Parameters<typeof acceptGitHubWebhook>[0],
): GitHubWebhookIntake {
  return { accept: (input) => acceptGitHubWebhook(pool, input) };
}

export interface GitHubWebhookApiOptions {
  secret: string;
  promptVersion: string;
  intake: GitHubWebhookIntake;
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

export function registerGitHubWebhookRoutes(
  app: FastifyInstance,
  options: GitHubWebhookApiOptions,
): void {
  if (options.secret.trim().length === 0) {
    throw new Error('GitHub webhook secret is required.');
  }
  if (options.promptVersion.trim().length === 0) {
    throw new Error('Review prompt version is required.');
  }
  app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );

    webhookApp.post('/webhooks/github', async (request, reply) => {
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

      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(payload.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'invalid_payload' });
      }

      let review: ReturnType<typeof parsePullRequestReviewTrigger> = null;
      let command: ReturnType<typeof parsePullRequestCommentCommand> = null;
      if (eventName === 'pull_request') {
        try {
          review = parsePullRequestReviewTrigger(parsedPayload);
        } catch {
          return reply.code(400).send({ error: 'invalid_payload' });
        }
      } else if (eventName === 'issue_comment') {
        try {
          command = parsePullRequestCommentCommand(parsedPayload);
        } catch {
          return reply.code(400).send({ error: 'invalid_payload' });
        }
      }

      const outcome = await options.intake.accept({
        deliveryId,
        eventName,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
        promptVersion: options.promptVersion,
        review,
        command,
      });
      return reply.code(202).send({
        accepted: outcome.status !== 'duplicate',
        queued: outcome.status === 'queued' || outcome.status === 'command_queued',
      });
    });
  });
}

export function createGitHubWebhookApi(options: GitHubWebhookApiOptions) {
  const app = Fastify({ logger: false });
  registerGitHubWebhookRoutes(app, options);
  return app;
}
