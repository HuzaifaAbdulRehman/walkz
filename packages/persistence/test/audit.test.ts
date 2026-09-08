import { describe, expect, it, vi } from 'vitest';

import { purgeExpiredAuditEvents, recordAuditEvent } from '../src/index.js';

describe('audit persistence', () => {
  it('allows only structured audit metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'audit-id' }] });

    await expect(
      recordAuditEvent({ query }, {
        actorUserId: null,
        eventType: 'credential.stored',
        summary: 'Stored provider credential.',
        metadata: {
          operation: 'credential.store',
          outcome: 'completed',
          subjectId: null,
        },
      }),
    ).resolves.toBe('audit-id');
    await expect(
      recordAuditEvent({ query }, {
        actorUserId: null,
        eventType: 'credential.stored',
        summary: 'Stored provider credential.',
        metadata: {
          operation: 'credential.store',
          outcome: 'completed',
          subjectId: null,
          rawPrompt: 'private code',
        },
      }),
    ).rejects.toThrow();
  });

  it('deletes audit events before the configured retention boundary', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    const before = new Date('2026-01-01T00:00:00.000Z');

    await expect(purgeExpiredAuditEvents({ query }, before)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM audit_events WHERE created_at < $1',
      [before],
    );
  });
});
