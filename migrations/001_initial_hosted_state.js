export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      github_id bigint NOT NULL UNIQUE CHECK (github_id > 0),
      login text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      token_hash char(64) NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE github_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      github_id bigint NOT NULL UNIQUE CHECK (github_id > 0),
      account_login text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_installations (
      user_id uuid NOT NULL REFERENCES users(id),
      installation_id uuid NOT NULL REFERENCES github_installations(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, installation_id)
    );

    CREATE TABLE repositories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id uuid NOT NULL REFERENCES github_installations(id),
      github_id bigint NOT NULL CHECK (github_id > 0),
      owner_login text NOT NULL,
      repository_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (installation_id, github_id)
    );

    CREATE TABLE repository_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES repositories(id),
      schema_version integer NOT NULL CHECK (schema_version > 0),
      config_hash char(64) NOT NULL,
      config jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, config_hash)
    );

    CREATE TABLE provider_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES repositories(id),
      provider text NOT NULL,
      encryption_key_id text NOT NULL,
      encrypted_value bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, provider)
    );

    CREATE TABLE pull_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES repositories(id),
      github_id bigint NOT NULL CHECK (github_id > 0),
      number integer NOT NULL CHECK (number > 0),
      base_sha char(40) NOT NULL,
      head_sha char(40) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, number)
    );

    CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id text NOT NULL UNIQUE,
      installation_id uuid REFERENCES github_installations(id),
      event_name text NOT NULL,
      payload_hash char(64) NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE review_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES repositories(id),
      pull_request_id uuid REFERENCES pull_requests(id),
      config_id uuid NOT NULL REFERENCES repository_configs(id),
      config_hash char(64) NOT NULL,
      base_sha char(40) NOT NULL,
      head_sha char(40) NOT NULL CHECK (base_sha <> head_sha),
      provider text NOT NULL,
      model text NOT NULL,
      prompt_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'collecting_context', 'deterministic_checks', 'reviewing', 'challenging', 'proving', 'awaiting_human', 'fixing', 'reproving', 'completed', 'inconclusive', 'failed', 'cancelled', 'superseded')),
      superseded_by uuid REFERENCES review_runs(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    CREATE TABLE review_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_run_id uuid NOT NULL REFERENCES review_runs(id),
      step_kind text NOT NULL,
      attempt integer NOT NULL CHECK (attempt > 0),
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (review_run_id, step_kind, attempt)
    );

    CREATE TABLE findings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_run_id uuid NOT NULL REFERENCES review_runs(id),
      fingerprint char(64) NOT NULL,
      lifecycle_status text NOT NULL,
      evidence_level text NOT NULL CHECK (evidence_level IN ('VERIFIED', 'SUPPORTED', 'UNVERIFIED')),
      summary text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (review_run_id, fingerprint)
    );

    CREATE TABLE evidence (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id uuid NOT NULL REFERENCES findings(id),
      evidence_kind text NOT NULL,
      command_digest char(64),
      base_exit_code integer,
      head_exit_code integer,
      duration_ms integer NOT NULL CHECK (duration_ms >= 0),
      sanitized_summary text NOT NULL,
      artifact_hashes jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE patch_proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_run_id uuid NOT NULL REFERENCES review_runs(id),
      finding_id uuid NOT NULL REFERENCES findings(id),
      patch_hash char(64) NOT NULL,
      github_reference text,
      approval_status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE model_invocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_run_id uuid NOT NULL REFERENCES review_runs(id),
      provider text NOT NULL,
      model text NOT NULL,
      prompt_version text NOT NULL,
      prompt_hash char(64) NOT NULL,
      response_hash char(64) NOT NULL,
      usage jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_id uuid NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id uuid REFERENCES users(id),
      event_type text NOT NULL,
      summary text NOT NULL,
      metadata jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE FUNCTION prevent_review_run_reactivation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status IN ('completed', 'inconclusive', 'failed', 'cancelled', 'superseded')
        AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Terminal review runs cannot change status.';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER review_runs_terminal_status_guard
    BEFORE UPDATE OF status ON review_runs
    FOR EACH ROW EXECUTE FUNCTION prevent_review_run_reactivation();
  `);
};

export const down = false;
