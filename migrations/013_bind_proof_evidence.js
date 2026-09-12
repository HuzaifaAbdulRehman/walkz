export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE evidence
      ADD COLUMN plan_digest char(64),
      ADD COLUMN base_outcome text,
      ADD COLUMN head_outcome text,
      ADD CONSTRAINT evidence_plan_digest_check CHECK (
        plan_digest IS NULL OR plan_digest ~ '^[a-f0-9]{64}$'
      ) NOT VALID,
      ADD CONSTRAINT evidence_base_outcome_check CHECK (
        base_outcome IS NULL OR base_outcome IN (
          'passed', 'failed', 'timed_out', 'cancelled', 'infrastructure_error'
        )
      ) NOT VALID,
      ADD CONSTRAINT evidence_head_outcome_check CHECK (
        head_outcome IS NULL OR head_outcome IN (
          'passed', 'failed', 'timed_out', 'cancelled', 'infrastructure_error'
        )
      ) NOT VALID;
  `);
  pgm.sql(`
    UPDATE evidence
    SET plan_digest = reproof_result->'proof'->>'planDigest',
        head_outcome = reproof_result->'proof'->>'outcome'
    WHERE evidence_kind = 'patch_reproof';
  `);
  pgm.sql(`
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_patch_reproof_plan_check CHECK (
        evidence_kind <> 'patch_reproof' OR
        (plan_digest IS NOT NULL AND head_outcome IS NOT NULL)
      ) NOT VALID;

    ALTER TABLE evidence
      DROP CONSTRAINT evidence_reproof_result_binding_check,
      ADD CONSTRAINT evidence_reproof_result_binding_check CHECK (
        evidence_kind <> 'patch_reproof' OR
        (jsonb_typeof(reproof_result) = 'object' AND
          reproof_result->>'schemaVersion' = '1' AND
          reproof_result->>'proposalId' = patch_proposal_id::text AND
          reproof_result->>'reviewRunId' = review_run_id::text AND
          reproof_result->>'findingId' = finding_id::text AND
          reproof_result->>'attempt' = reproof_attempt::text AND
          reproof_result->>'patchHash' = patch_hash::text AND
          reproof_result->>'headSha' = head_sha::text AND
          reproof_result->>'outcome' = reproof_outcome AND
          reproof_result->'proof'->>'planDigest' = plan_digest::text AND
          reproof_result->'proof'->>'outcome' = head_outcome)
      ) NOT VALID;

    ALTER TABLE evidence
      VALIDATE CONSTRAINT evidence_plan_digest_check,
      VALIDATE CONSTRAINT evidence_base_outcome_check,
      VALIDATE CONSTRAINT evidence_head_outcome_check,
      VALIDATE CONSTRAINT evidence_patch_reproof_plan_check;
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY evidence_counterfactual_binding_idx
      ON evidence (finding_id, plan_digest, command_digest, created_at)
      WHERE evidence_kind = 'counterfactual_proof';
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
