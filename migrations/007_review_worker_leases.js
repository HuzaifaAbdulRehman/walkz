export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE review_runs
      ADD COLUMN worker_lease_owner text,
      ADD COLUMN worker_lease_expires_at timestamptz,
      ADD COLUMN worker_attempts integer NOT NULL DEFAULT 0
        CHECK (worker_attempts >= 0);

    CREATE INDEX review_runs_worker_recovery_idx
      ON review_runs (worker_lease_expires_at, created_at)
      WHERE status IN (
        'queued', 'collecting_context', 'deterministic_checks',
        'reviewing', 'challenging', 'proving', 'reproving'
      );
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
