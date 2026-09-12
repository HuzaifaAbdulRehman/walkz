export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE patch_proposals
      ADD CONSTRAINT patch_proposals_github_reference_state_v2_check
      CHECK (
        github_reference IS NULL OR
        approval_status IN ('pending', 'approved')
      ) NOT VALID;

    ALTER TABLE patch_proposals
      VALIDATE CONSTRAINT patch_proposals_github_reference_state_v2_check;

    ALTER TABLE patch_proposals
      DROP CONSTRAINT patch_proposals_github_reference_state_check;

    ALTER TABLE patch_proposals
      RENAME CONSTRAINT patch_proposals_github_reference_state_v2_check
      TO patch_proposals_github_reference_state_check;
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
