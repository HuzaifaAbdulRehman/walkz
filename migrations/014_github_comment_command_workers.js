export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE github_comment_commands
      ADD COLUMN attempt integer NOT NULL DEFAULT 0
        CHECK (attempt BETWEEN 0 AND 100),
      ADD COLUMN lease_owner text,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN review_run_id uuid UNIQUE REFERENCES review_runs(id),
      ADD COLUMN failure_code text CHECK (
        failure_code IS NULL OR failure_code = 'workflow_failed'
      ),
      ADD CONSTRAINT github_comment_commands_lease_pair_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      ADD CONSTRAINT github_comment_commands_failure_check CHECK (
        (status = 'failed' AND failure_code IS NOT NULL) OR
        (status <> 'failed' AND failure_code IS NULL)
      );

    DROP TRIGGER github_comment_commands_terminal_status_guard
      ON github_comment_commands;

    CREATE OR REPLACE FUNCTION prevent_github_comment_command_reactivation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status IN ('completed', 'denied', 'ignored', 'failed')
        AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminal comment commands cannot be changed.';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER github_comment_commands_terminal_status_guard
    BEFORE UPDATE ON github_comment_commands
    FOR EACH ROW EXECUTE FUNCTION prevent_github_comment_command_reactivation();
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY github_comment_commands_recovery_idx
      ON github_comment_commands (lease_expires_at, updated_at, id)
      WHERE status IN ('queued', 'processing');
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
