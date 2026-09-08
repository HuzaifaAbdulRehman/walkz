import { describe, expect, it, vi } from 'vitest';

import { recordWebhookDelivery } from '../src/index.js';

const input = {
  deliveryId: 'delivery-1',
  eventName: 'pull_request',
  payloadHash: 'a'.repeat(64),
};

describe('webhook delivery persistence', () => {
  it('uses the delivery ID uniqueness constraint for acceptance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'stored-id' }] });

    await expect(recordWebhookDelivery({ query }, input)).resolves.toBe('accepted');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (delivery_id) DO NOTHING'),
      [input.deliveryId, input.eventName, input.payloadHash],
    );
  });

  it('reports a duplicate when PostgreSQL inserts no row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(recordWebhookDelivery({ query }, input)).resolves.toBe('duplicate');
  });
});
