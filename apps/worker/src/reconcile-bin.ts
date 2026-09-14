import { recoverDurableWorkFromEnvironment } from './durable-recovery.js';

try {
  const result = await recoverDurableWorkFromEnvironment(process.env);
  process.stdout.write(
    `Reconciled durable work: outbox=${result.outbox}, ` +
    `comment_commands=${result.commentCommands}, reviews=${result.reviews}, ` +
    `patch_fixes=${result.patchFixes}.\n`,
  );
} catch {
  process.stderr.write('Durable queue reconciliation failed.\n');
  process.exitCode = 1;
}
