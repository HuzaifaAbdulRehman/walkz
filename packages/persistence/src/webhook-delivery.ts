import type { Pool, PoolClient } from 'pg';

export interface WebhookDeliveryInput {
  deliveryId: string;
  eventName: string;
  payloadHash: string;
}

export async function insertWebhookDelivery(
  client: Pick<PoolClient, 'query'>,
  input: WebhookDeliveryInput,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [input.deliveryId, input.eventName, input.payloadHash],
  );
  return result.rows[0]?.id ?? null;
}

export async function recordWebhookDelivery(
  pool: Pick<Pool, 'query'>,
  input: WebhookDeliveryInput,
): Promise<'accepted' | 'duplicate'> {
  return (await insertWebhookDelivery(pool, input)) === null
    ? 'duplicate'
    : 'accepted';
}
