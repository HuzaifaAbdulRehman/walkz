export const up = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s'");
  pgm.sql(`
    CREATE TABLE finding_feedback (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL UNIQUE,
      review_run_id uuid NOT NULL,
      finding_id uuid NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      assessment text NOT NULL CHECK (
        assessment IN ('correct', 'false_positive')
      ),
      reason text CHECK (
        reason IS NULL OR reason IN (
          'incorrect_claim', 'intentional_behavior', 'not_actionable',
          'duplicate', 'other'
        )
      ),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT finding_feedback_finding_fkey
        FOREIGN KEY (review_run_id, finding_id)
        REFERENCES findings (review_run_id, id),
      CONSTRAINT finding_feedback_assessment_reason_check CHECK (
        (assessment = 'correct' AND reason IS NULL) OR
        assessment = 'false_positive'
      )
    );

    CREATE INDEX finding_feedback_finding_created_idx
      ON finding_feedback (finding_id, created_at, id);
  `);
};

export const down = false;
