export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS model_invocations_run_key_idx;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY model_invocations_run_key_idx
      ON model_invocations (review_run_id, invocation_key);
  `);
};

export const down = false;
