import type { Pool } from 'pg';

export interface WebhookDeliveryInput {
  deliveryId: string;
  eventName: string;
  payloadHash: string;
}

export async function recordWebhookDelivery(
  pool: Pick<Pool, 'query'>,
  input: WebhookDeliveryInput,
): Promise<'accepted' | 'duplicate'> {
  const result = await pool.query(
    `
      INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [input.deliveryId, input.eventName, input.payloadHash],
  );
  return result.rows.length === 1 ? 'accepted' : 'duplicate';
}
