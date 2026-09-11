export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE evidence
      ADD COLUMN review_run_id uuid,
      ADD COLUMN patch_proposal_id uuid,
      ADD COLUMN patch_hash char(64),
      ADD COLUMN head_sha char(40),
      ADD COLUMN reproof_attempt integer,
      ADD COLUMN reproof_outcome text,
      ADD COLUMN reproof_result jsonb,
      ADD CONSTRAINT evidence_reproof_attempt_check
        CHECK (reproof_attempt IS NULL OR reproof_attempt > 0) NOT VALID,
      ADD CONSTRAINT evidence_reproof_outcome_check
        CHECK (
          reproof_outcome IS NULL OR
          reproof_outcome IN ('resolved', 'unresolved', 'inconclusive')
        ) NOT VALID,
      ADD CONSTRAINT evidence_reproof_metadata_check
        CHECK (
          (evidence_kind = 'patch_reproof' AND
            review_run_id IS NOT NULL AND
            patch_proposal_id IS NOT NULL AND
            patch_hash IS NOT NULL AND
            head_sha IS NOT NULL AND
            reproof_attempt IS NOT NULL AND
            reproof_outcome IS NOT NULL AND
            reproof_result IS NOT NULL) OR
          (evidence_kind <> 'patch_reproof' AND
            review_run_id IS NULL AND
            patch_proposal_id IS NULL AND
            patch_hash IS NULL AND
            head_sha IS NULL AND
            reproof_attempt IS NULL AND
            reproof_outcome IS NULL AND
            reproof_result IS NULL)
        ) NOT VALID,
      ADD CONSTRAINT evidence_reproof_result_binding_check
        CHECK (
          evidence_kind <> 'patch_reproof' OR
          (jsonb_typeof(reproof_result) = 'object' AND
            reproof_result->>'schemaVersion' = '1' AND
            reproof_result->>'proposalId' = patch_proposal_id::text AND
            reproof_result->>'reviewRunId' = review_run_id::text AND
            reproof_result->>'findingId' = finding_id::text AND
            reproof_result->>'attempt' = reproof_attempt::text AND
            reproof_result->>'patchHash' = patch_hash::text AND
            reproof_result->>'headSha' = head_sha::text AND
            reproof_result->>'outcome' = reproof_outcome)
        ) NOT VALID,
      ADD CONSTRAINT evidence_reproof_finding_fkey
        FOREIGN KEY (review_run_id, finding_id)
        REFERENCES findings (review_run_id, id) NOT VALID;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY patch_proposals_reproof_identity_idx
      ON patch_proposals (
        id, review_run_id, finding_id, patch_hash, head_sha
      );
  `);
  pgm.sql(`
    ALTER TABLE patch_proposals
      ADD CONSTRAINT patch_proposals_reproof_identity_key
        UNIQUE USING INDEX patch_proposals_reproof_identity_idx;

    ALTER TABLE evidence
      ADD CONSTRAINT evidence_reproof_proposal_fkey
        FOREIGN KEY (
          patch_proposal_id, review_run_id, finding_id, patch_hash, head_sha
        )
        REFERENCES patch_proposals (
          id, review_run_id, finding_id, patch_hash, head_sha
        ) NOT VALID;

    ALTER TABLE evidence
      VALIDATE CONSTRAINT evidence_reproof_attempt_check,
      VALIDATE CONSTRAINT evidence_reproof_outcome_check,
      VALIDATE CONSTRAINT evidence_reproof_metadata_check,
      VALIDATE CONSTRAINT evidence_reproof_result_binding_check,
      VALIDATE CONSTRAINT evidence_reproof_finding_fkey,
      VALIDATE CONSTRAINT evidence_reproof_proposal_fkey;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY evidence_patch_reproof_attempt_key
      ON evidence (patch_proposal_id, reproof_attempt)
      WHERE evidence_kind = 'patch_reproof';
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
