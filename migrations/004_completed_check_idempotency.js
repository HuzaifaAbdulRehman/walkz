export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("SET lock_timeout = '5s';");
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY outbox_events_completed_check_idx
      ON outbox_events (aggregate_id, event_type)
      WHERE event_type = 'github_check.completed';
  `);
  pgm.sql('RESET lock_timeout;');
};

export const down = false;
