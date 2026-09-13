import type { DashboardConfiguration } from './lib/reviews';

function formatBytes(bytes: number): string {
  if (bytes >= 1_024 * 1_024) return `${Math.round(bytes / (1_024 * 1_024))} MB`;
  return `${Math.round(bytes / 1_024)} KB`;
}

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatTrigger(trigger: DashboardConfiguration['triggerPolicy']): string {
  return trigger.replaceAll('_', ' ');
}

function formatApprovalPolicy(policy: DashboardConfiguration['commandApprovalPolicy']): string {
  return policy.replaceAll('_', ' ');
}

export function ConfigurationHistory({
  configurations,
  unavailable,
}: {
  configurations: DashboardConfiguration[];
  unavailable: boolean;
}) {
  if (unavailable) {
    return <p className="empty-state">Configuration history is temporarily unavailable. Try again later.</p>;
  }
  if (configurations.length === 0) {
    return <p className="empty-state">No saved configuration is available for this repository yet.</p>;
  }
  const latest = configurations[0];
  if (latest === undefined) {
    throw new Error('Configuration history was unexpectedly empty.');
  }
  return (
    <>
      <article className="configuration-overview">
        <div>
          <p className="configuration-label">Current review settings</p>
          <h3>{latest.provider.name} / {latest.provider.model}</h3>
          <p className="detail">Recorded {latest.createdAt}</p>
        </div>
        <dl className="configuration-facts">
          <div><dt>Trigger</dt><dd>{formatTrigger(latest.triggerPolicy)}</dd></div>
          <div><dt>Evidence blocks</dt><dd>{latest.blockingEvidenceLevels.join(', ')}</dd></div>
          <div><dt>Policy packs</dt><dd>{latest.policyPacks.join(', ') || 'None'}</dd></div>
          <div><dt>Review budget</dt><dd>{formatBytes(latest.budget.diffBytes)}, {latest.budget.files} files, {formatInteger(latest.budget.tokens)} tokens</dd></div>
          <div><dt>Checks</dt><dd>{latest.requiredCommandCount} required of {latest.commandCount}</dd></div>
          <div><dt>Approval</dt><dd>{formatApprovalPolicy(latest.commandApprovalPolicy)}</dd></div>
        </dl>
      </article>
      <div className="configuration-list">
        {configurations.map((configuration) => (
          <article className="configuration-card" key={configuration.id}>
            <div>
              <h3>Configuration v{configuration.schemaVersion}</h3>
              <p className="detail">Recorded {configuration.createdAt}</p>
            </div>
            <code className="config-hash">{configuration.configHash.slice(0, 12)}</code>
          </article>
        ))}
      </div>
    </>
  );
}
