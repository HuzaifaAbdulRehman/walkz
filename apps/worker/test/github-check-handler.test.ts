import { describe, expect, it, vi } from 'vitest';

import { createGitHubCheckOutboxHandler } from '../src/index.js';

const event = {
  id: '4b79fc1b-1c89-4431-9d76-02ca23296ccd',
  aggregateId: 'efaa8b7e-6e48-445a-83d5-d2cc730ef816',
  eventType: 'github_check.queued',
  payload: {
    reviewRunId: 'efaa8b7e-6e48-445a-83d5-d2cc730ef816',
    installationId: '1234',
    owner: 'owner',
    repository: 'repo',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
};

const completedEvent = {
  ...event,
  id: 'edab20a3-473e-498d-9f01-c93907ba7d25',
  eventType: 'github_check.completed',
  payload: {
    ...event.payload,
    verdict: 'FIX',
    summary: 'One verified regression needs attention.',
    findings: [{
      path: 'src/index.ts',
      startLine: 4,
      endLine: 4,
      severity: 'high',
      summary: 'The head revision fails the reproducer.',
    }],
  },
};

describe('GitHub check outbox handler', () => {
  it('publishes one exact-SHA pending check with the review run as its stable key', async () => {
    const publish = vi.fn().mockResolvedValue(42);
    const forInstallation = vi.fn().mockResolvedValue({ publish });
    const handler = createGitHubCheckOutboxHandler({ forInstallation });

    await expect(handler.handle(event, { idempotencyKey: event.id })).resolves.toBeUndefined();
    expect(forInstallation).toHaveBeenCalledWith('1234');
    expect(publish).toHaveBeenCalledWith(
      { owner: 'owner', repository: 'repo' },
      {
        name: 'Walkz / review',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        status: 'queued',
        conclusion: null,
        summary: 'Walkz accepted this review and queued analysis for the exact pull request head.',
        annotations: [],
      },
      event.aggregateId,
    );
  });

  it('rejects malformed events before requesting installation credentials', async () => {
    const forInstallation = vi.fn();
    const handler = createGitHubCheckOutboxHandler({ forInstallation });

    await expect(handler.handle(
      { ...event, eventType: 'review_run.queued' },
      { idempotencyKey: event.id },
    )).rejects.toThrow();
    expect(forInstallation).not.toHaveBeenCalled();
  });

  it('updates the same exact-SHA check with the final verdict', async () => {
    const publish = vi.fn().mockResolvedValue(42);
    const forInstallation = vi.fn().mockResolvedValue({ publish });
    const handler = createGitHubCheckOutboxHandler({ forInstallation });

    await handler.handle(completedEvent, { idempotencyKey: completedEvent.id });
    expect(publish).toHaveBeenCalledWith(
      { owner: 'owner', repository: 'repo' },
      expect.objectContaining({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        status: 'completed',
        conclusion: 'failure',
        annotations: [expect.objectContaining({
          path: 'src/index.ts',
          level: 'failure',
        })],
      }),
      event.aggregateId,
    );
  });

  it('rejects a mismatched dispatch idempotency key', async () => {
    const forInstallation = vi.fn();
    const handler = createGitHubCheckOutboxHandler({ forInstallation });

    await expect(handler.handle(event, { idempotencyKey: 'another-event' })).rejects.toThrow(
      'idempotency key must match',
    );
    expect(forInstallation).not.toHaveBeenCalled();
  });
});
