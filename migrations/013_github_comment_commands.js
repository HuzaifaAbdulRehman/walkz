export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    CREATE TABLE github_comment_commands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      webhook_delivery_id uuid NOT NULL UNIQUE REFERENCES webhook_deliveries(id),
      repository_id uuid NOT NULL REFERENCES repositories(id),
      github_comment_id bigint NOT NULL UNIQUE CHECK (github_comment_id > 0),
      commenter_github_id bigint NOT NULL CHECK (commenter_github_id > 0),
      commenter_login text NOT NULL CHECK (length(commenter_login) BETWEEN 1 AND 100),
      pull_request_number integer NOT NULL CHECK (pull_request_number > 0),
      command text NOT NULL CHECK (command IN ('review', 'propose_fix')),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'processing', 'completed', 'denied', 'ignored', 'failed'
      )),
      reply_url text CHECK (reply_url IS NULL OR length(reply_url) BETWEEN 1 AND 512),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT github_comment_commands_terminal_check CHECK (
        (status IN ('completed', 'denied', 'ignored', 'failed')
          AND completed_at IS NOT NULL) OR
        (status IN ('queued', 'processing') AND completed_at IS NULL)
      ),
      CONSTRAINT github_comment_commands_timestamps_check CHECK (
        updated_at >= created_at AND
        (completed_at IS NULL OR completed_at >= created_at)
      )
    );

    CREATE INDEX github_comment_commands_repository_idx
      ON github_comment_commands (repository_id, created_at DESC, id DESC);

    CREATE FUNCTION prevent_github_comment_command_reactivation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status IN ('completed', 'denied', 'ignored', 'failed')
        AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Terminal comment commands cannot change status.';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER github_comment_commands_terminal_status_guard
    BEFORE UPDATE OF status ON github_comment_commands
    FOR EACH ROW EXECUTE FUNCTION prevent_github_comment_command_reactivation();
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY outbox_github_comment_command_queued_key
      ON outbox_events (aggregate_id, event_type)
      WHERE event_type = 'github_comment_command.queued';
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
