export const up = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE model_invocations
      ADD COLUMN invocation_key char(64),
      ADD COLUMN stage text,
      ADD COLUMN status text,
      ADD COLUMN attempt_count integer NOT NULL DEFAULT 1,
      ADD COLUMN request_id text,
      ADD COLUMN error_code text,
      ADD COLUMN duration_ms integer,
      ALTER COLUMN response_hash DROP NOT NULL,
      ALTER COLUMN usage DROP NOT NULL;

    UPDATE model_invocations
    SET invocation_key = encode(digest(id::text, 'sha256'), 'hex'),
        stage = 'review',
        status = 'succeeded',
        duration_ms = 0;

    ALTER TABLE model_invocations
      ALTER COLUMN invocation_key SET NOT NULL,
      ALTER COLUMN stage SET NOT NULL,
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN duration_ms SET NOT NULL,
      ADD CONSTRAINT model_invocations_invocation_key_check
        CHECK (invocation_key ~ '^[a-f0-9]{64}$') NOT VALID,
      ADD CONSTRAINT model_invocations_stage_check
        CHECK (stage IN ('review', 'patch', 'challenger', 'security')) NOT VALID,
      ADD CONSTRAINT model_invocations_status_check
        CHECK (status IN ('succeeded', 'failed')) NOT VALID,
      ADD CONSTRAINT model_invocations_attempt_count_check
        CHECK (attempt_count > 0) NOT VALID,
      ADD CONSTRAINT model_invocations_duration_check
        CHECK (duration_ms >= 0 AND duration_ms <= 3600000) NOT VALID,
      ADD CONSTRAINT model_invocations_request_id_check
        CHECK (request_id IS NULL OR octet_length(request_id) BETWEEN 1 AND 512)
        NOT VALID,
      ADD CONSTRAINT model_invocations_error_code_check
        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,128}$')
        NOT VALID,
      ADD CONSTRAINT model_invocations_outcome_check
        CHECK (
          (status = 'succeeded' AND response_hash IS NOT NULL AND
            usage IS NOT NULL AND error_code IS NULL) OR
          (status = 'failed' AND response_hash IS NULL AND
            usage IS NULL AND error_code IS NOT NULL)
        ) NOT VALID;

    ALTER TABLE model_invocations
      VALIDATE CONSTRAINT model_invocations_invocation_key_check,
      VALIDATE CONSTRAINT model_invocations_stage_check,
      VALIDATE CONSTRAINT model_invocations_status_check,
      VALIDATE CONSTRAINT model_invocations_attempt_count_check,
      VALIDATE CONSTRAINT model_invocations_duration_check,
      VALIDATE CONSTRAINT model_invocations_request_id_check,
      VALIDATE CONSTRAINT model_invocations_error_code_check,
      VALIDATE CONSTRAINT model_invocations_outcome_check;
  `);
};

export const down = false;
