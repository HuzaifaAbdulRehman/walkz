export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    CREATE TABLE oauth_states (
      id uuid PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE sessions
      ADD COLUMN revoked_at timestamptz;

    CREATE TABLE user_repository_access (
      user_id uuid NOT NULL,
      installation_id uuid NOT NULL,
      github_repository_id bigint NOT NULL CHECK (github_repository_id > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, installation_id, github_repository_id),
      FOREIGN KEY (user_id, installation_id)
        REFERENCES user_installations (user_id, installation_id)
        ON DELETE CASCADE
    );

    CREATE INDEX oauth_states_expires_at_idx ON oauth_states (expires_at);
    CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
    CREATE INDEX user_repository_access_repository_idx
      ON user_repository_access (installation_id, github_repository_id);
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
