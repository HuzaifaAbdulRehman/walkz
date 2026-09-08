export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE outbox_events
      ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      ADD COLUMN lease_owner text,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN last_error text;

    CREATE INDEX outbox_events_pending_created_at_idx
      ON outbox_events (created_at)
      WHERE published_at IS NULL;
  `);
};

export const down = false;
