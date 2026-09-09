export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE findings
      ADD COLUMN category text CHECK (
        category IS NULL OR category IN (
          'correctness', 'security', 'performance', 'reliability',
          'maintainability'
        )
      ),
      ADD COLUMN severity text CHECK (
        severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')
      ),
      ADD COLUMN file_path text,
      ADD COLUMN start_line integer CHECK (start_line IS NULL OR start_line > 0),
      ADD COLUMN end_line integer CHECK (
        end_line IS NULL OR (end_line > 0 AND end_line >= start_line)
      ),
      ADD COLUMN claim text,
      ADD COLUMN failure_mechanism text,
      ADD COLUMN suggested_proof text,
      ADD COLUMN advisory_confidence double precision CHECK (
        advisory_confidence IS NULL OR
        advisory_confidence BETWEEN 0 AND 1
      );
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY findings_review_run_created_at_idx
      ON findings (review_run_id, created_at, id);
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
