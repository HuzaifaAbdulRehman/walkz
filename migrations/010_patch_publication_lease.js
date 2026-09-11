export const up = (pgm) => {
  pgm.sql("SET lock_timeout = '5s'");
  pgm.sql(`
    ALTER TABLE patch_proposals
      ADD COLUMN publication_lease_owner uuid,
      ADD COLUMN publication_lease_expires_at timestamptz,
      ADD CONSTRAINT patch_proposals_publication_lease_pair_check
        CHECK (
          (publication_lease_owner IS NULL AND
            publication_lease_expires_at IS NULL) OR
          (publication_lease_owner IS NOT NULL AND
            publication_lease_expires_at IS NOT NULL)
        );

    CREATE INDEX patch_proposals_publication_lease_idx
      ON patch_proposals (publication_lease_expires_at)
      WHERE publication_lease_owner IS NOT NULL;
  `);
  pgm.sql('RESET lock_timeout');
};

export const down = false;
