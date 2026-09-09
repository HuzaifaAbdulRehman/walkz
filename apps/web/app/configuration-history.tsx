import type { DashboardConfiguration } from './lib/reviews';

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
  return (
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
  );
}
