export const up = (pgm) => {
  pgm.sql(`
    SET LOCAL lock_timeout = '5s';

    ALTER TABLE review_runs
      ADD COLUMN verdict text CHECK (
        verdict IN ('SHIP', 'FIX', 'HUMAN', 'INCONCLUSIVE', 'ERROR')
      ),
      ADD COLUMN result_summary text;
  `);
};

export const down = false;
