export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    CREATE TABLE patch_fix_jobs (
      proposal_id uuid PRIMARY KEY REFERENCES patch_proposals(id),
      provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
      model text NOT NULL CHECK (length(model) BETWEEN 1 AND 512),
      prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 256),
      proof_plan_digest char(64) NOT NULL,
      proof_command_digest char(64) NOT NULL,
      status text NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN (
        'awaiting_approval', 'queued', 'reproving', 'resolved',
        'unresolved', 'inconclusive', 'rejected', 'failed'
      )),
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
      lease_owner text,
      lease_expires_at timestamptz,
      failure_code text CHECK (failure_code IS NULL OR failure_code IN (
        'candidate_changed', 'proof_binding_invalid',
        'proof_infrastructure_failed', 'github_publication_failed',
        'workflow_failed'
      )),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT patch_fix_jobs_digest_check CHECK (
        proof_plan_digest ~ '^[a-f0-9]{64}$' AND
        proof_command_digest ~ '^[a-f0-9]{64}$'
      ),
      CONSTRAINT patch_fix_jobs_lease_pair_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CONSTRAINT patch_fix_jobs_terminal_check CHECK (
        (status IN ('resolved', 'unresolved', 'inconclusive', 'rejected', 'failed')
          AND completed_at IS NOT NULL) OR
        (status NOT IN ('resolved', 'unresolved', 'inconclusive', 'rejected', 'failed')
          AND completed_at IS NULL)
      ),
      CONSTRAINT patch_fix_jobs_failure_check CHECK (
        (status = 'failed' AND failure_code IS NOT NULL) OR
        (status <> 'failed' AND failure_code IS NULL)
      ),
      CONSTRAINT patch_fix_jobs_timestamps_check CHECK (
        updated_at >= created_at AND
        (completed_at IS NULL OR completed_at >= created_at)
      )
    );

    CREATE INDEX patch_fix_jobs_recovery_idx
      ON patch_fix_jobs (lease_expires_at, updated_at, proposal_id)
      WHERE status IN ('queued', 'reproving');

  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY outbox_patch_fix_queued_key
      ON outbox_events (aggregate_id, event_type)
      WHERE event_type = 'patch_fix.queued';
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
