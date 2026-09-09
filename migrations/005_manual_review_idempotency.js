export const up = (pgm) => {
  pgm.sql(`
    SET LOCAL lock_timeout = '5s';

    CREATE TABLE manual_review_requests (
      request_id uuid PRIMARY KEY,
      repository_id uuid NOT NULL REFERENCES repositories(id),
      pull_request_number integer NOT NULL CHECK (pull_request_number > 0),
      base_sha char(40) NOT NULL,
      head_sha char(40) NOT NULL CHECK (base_sha <> head_sha),
      review_run_id uuid REFERENCES review_runs(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

export const down = false;
