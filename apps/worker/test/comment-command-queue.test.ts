import { describe, expect, it, vi } from 'vitest';

import { enqueueCommentCommand, recoverCommentCommands } from '../src/index.js';

const commandId = '9058b3c9-3243-43b3-b0d8-dd692ece130f';

describe('comment command queue', () => {
  it('uses the durable command ID as the BullMQ job ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await enqueueCommentCommand({ add }, commandId);

    expect(add).toHaveBeenCalledWith('comment-command', { commandId }, {
      jobId: commandId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('restores PostgreSQL-owned commands to disposable Redis state', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const listRecoverableGitHubCommentCommandIds = vi.fn()
      .mockResolvedValue([commandId]);

    await expect(recoverCommentCommands(
      { add },
      { listRecoverableGitHubCommentCommandIds },
      100,
    )).resolves.toBe(1);
    expect(add).toHaveBeenCalledWith(
      'comment-command',
      { commandId },
      expect.objectContaining({ jobId: commandId }),
    );
  });

  it('rejects malformed command IDs before touching Redis', async () => {
    const add = vi.fn();

    await expect(enqueueCommentCommand({ add }, 'not-a-uuid')).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
