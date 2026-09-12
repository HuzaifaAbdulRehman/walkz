export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE github_comment_commands
      ADD COLUMN patch_proposal_id uuid UNIQUE REFERENCES patch_proposals(id),
      ADD CONSTRAINT github_comment_commands_completion_target_check CHECK (
        (status = 'completed' AND
          num_nonnulls(review_run_id, patch_proposal_id) = 1) OR
        (status IN ('queued', 'processing', 'failed') AND review_run_id IS NULL) OR
        (status IN ('denied', 'ignored') AND
          review_run_id IS NULL AND patch_proposal_id IS NULL)
      );
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
