export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM patch_proposals LIMIT 1) THEN
        RAISE EXCEPTION
          'patch_proposals must be empty before enabling the approved fix loop';
      END IF;
    END
    $$;

    ALTER TABLE patch_proposals
      ADD COLUMN base_sha char(40) NOT NULL,
      ADD COLUMN head_sha char(40) NOT NULL,
      ADD COLUMN delivery_mode text NOT NULL,
      ADD COLUMN github_reference_kind text,
      ADD COLUMN decided_by_user_id uuid REFERENCES users(id),
      ADD COLUMN decided_at timestamptz,
      ADD COLUMN stale_at timestamptz,
      ADD COLUMN updated_at timestamptz NOT NULL;

    ALTER TABLE patch_proposals
      ADD CONSTRAINT patch_proposals_revisions_differ
        CHECK (base_sha <> head_sha),
      ADD CONSTRAINT patch_proposals_delivery_mode_check
        CHECK (delivery_mode IN ('suggestion', 'fix_branch')),
      ADD CONSTRAINT patch_proposals_approval_status_check
        CHECK (approval_status IN (
          'pending', 'approved', 'rejected'
        )),
      ADD CONSTRAINT patch_proposals_decision_metadata_check
        CHECK (
          (approval_status = 'pending' AND
            decided_by_user_id IS NULL AND decided_at IS NULL) OR
          (approval_status IN ('approved', 'rejected') AND
            decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
        ),
      ADD CONSTRAINT patch_proposals_github_reference_pair_check
        CHECK (
          (github_reference IS NULL AND github_reference_kind IS NULL) OR
          (github_reference IS NOT NULL AND github_reference_kind IS NOT NULL)
        ),
      ADD CONSTRAINT patch_proposals_github_reference_length_check
        CHECK (
          github_reference IS NULL OR
          length(github_reference) BETWEEN 1 AND 512
        ),
      ADD CONSTRAINT patch_proposals_github_reference_state_check
        CHECK (github_reference IS NULL OR approval_status = 'approved'),
      ADD CONSTRAINT patch_proposals_timestamps_check
        CHECK (
          updated_at >= created_at AND
          (decided_at IS NULL OR decided_at >= created_at) AND
          (stale_at IS NULL OR stale_at >= created_at)
        ),
      ADD CONSTRAINT patch_proposals_github_reference_kind_check
        CHECK (
          github_reference_kind IS NULL OR
          (delivery_mode = 'suggestion' AND
            github_reference_kind = 'review_comment') OR
          (delivery_mode = 'fix_branch' AND
            github_reference_kind = 'fix_branch')
        );

    ALTER TABLE review_runs
      ADD CONSTRAINT review_runs_id_revision_key
        UNIQUE (id, base_sha, head_sha);

    ALTER TABLE findings
      ADD CONSTRAINT findings_review_run_id_id_key
        UNIQUE (review_run_id, id);

    ALTER TABLE patch_proposals
      ADD CONSTRAINT patch_proposals_review_run_revision_fkey
        FOREIGN KEY (review_run_id, base_sha, head_sha)
        REFERENCES review_runs (id, base_sha, head_sha),
      ADD CONSTRAINT patch_proposals_finding_run_fkey
        FOREIGN KEY (review_run_id, finding_id)
        REFERENCES findings (review_run_id, id),
      ADD CONSTRAINT patch_proposals_finding_head_patch_mode_key
        UNIQUE (finding_id, head_sha, patch_hash, delivery_mode);

    CREATE INDEX patch_proposals_review_run_status_idx
      ON patch_proposals (review_run_id, approval_status, created_at, id);
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
