'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { EmptyRepositoryState } from './auth-panel';
import type { DashboardInstallation } from './lib/reviews';

export function RepositoryPicker({
  installations,
}: {
  installations: DashboardInstallation[];
}) {
  const router = useRouter();
  const [pendingRepository, setPendingRepository] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const choices = installations.flatMap((installation) =>
    installation.repositories.map((repository) => ({ installationId: installation.id, repository })),
  );

  async function selectRepository(installationId: string, repositoryId: string) {
    setPendingRepository(repositoryId);
    setError(false);
    try {
      const response = await fetch(
        `/api/installations/${encodeURIComponent(installationId)}/repositories`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repositoryId }),
        },
      );
      if (response.status === 401) {
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error('Repository selection failed.');
      router.refresh();
    } catch {
      setError(true);
      setPendingRepository(null);
    }
  }

  return (
    <section aria-labelledby="choose-repository">
      <div className="setup-card">
        <p className="configuration-label">One-time setup</p>
        <h2 id="choose-repository">Choose a repository</h2>
        {choices.length === 0 ? (
          <EmptyRepositoryState />
        ) : (
          <>
            <p className="setup-copy">
              Select a repository to create its initial Walkz configuration.
            </p>
            <ul className="repository-choices">
              {choices.map(({ installationId, repository }) => {
                const pending = pendingRepository === repository.id;
                return (
                  <li key={`${installationId}:${repository.id}`}>
                    <button
                      className="repository-choice"
                      type="button"
                      disabled={pendingRepository !== null}
                      onClick={() => selectRepository(installationId, repository.id)}
                    >
                      <span>{repository.owner}/{repository.name}</span>
                      <span className="choice-action">{pending ? 'Selecting...' : 'Select'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {error ? (
          <p className="selection-error" role="alert">
            Walkz could not save that repository. Try again.
          </p>
        ) : null}
      </div>
    </section>
  );
}
