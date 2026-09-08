import { describe, expect, it } from 'vitest';

import { parseDatabasePoolConfig } from '../src/index.js';

const config = {
  connectionString: 'postgresql://walkz:secret@localhost:5432/walkz',
  maxConnections: 10,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
};

describe('database pool configuration', () => {
  it('accepts explicit PostgreSQL pool limits', () => {
    expect(parseDatabasePoolConfig(config)).toEqual(config);
  });

  it('rejects non-PostgreSQL URLs and unknown options', () => {
    expect(() =>
      parseDatabasePoolConfig({ ...config, connectionString: 'https://example.test' }),
    ).toThrow('PostgreSQL protocol');
    expect(() => parseDatabasePoolConfig({ ...config, ssl: true })).toThrow();
  });
});
