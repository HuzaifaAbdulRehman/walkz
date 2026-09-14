export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s';");
  pgm.sql(`
    CREATE INDEX CONCURRENTLY review_runs_telemetry_created_at_idx
      ON review_runs (created_at DESC)
      INCLUDE (status, verdict);
  `);
  pgm.sql('RESET lock_timeout;');
};

export const down = false;
