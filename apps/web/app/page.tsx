import { cookies } from 'next/headers';

import { AuthPanel, InstallationError } from './auth-panel';
import { ConfigurationHistory } from './configuration-history';
import {
  loadDashboardConfigurations,
  loadDashboardInstallations,
  loadDashboardReviews,
  type DashboardConfiguration,
  type DashboardReview,
} from './lib/reviews';
import { loadProviderCredentialStatus } from './lib/provider-credentials';
import { ProviderCredentialForm } from './provider-credential-form';
import { RepositoryPicker } from './repository-picker';
import { ReviewHistory } from './review-history';

export const dynamic = 'force-dynamic';

function Hero() {
  return (
    <header className="hero">
      <p className="eyebrow">WALKZ / REVIEW DASHBOARD</p>
      <h1>Evidence before merge.</h1>
      <p className="lede">Walkz separates model suggestions from deterministic review evidence.</p>
    </header>
  );
}

export default async function HomePage() {
  const session = (await cookies()).get('walkz_session')?.value;
  if (session === undefined) {
    return (
      <main className="shell">
        <Hero />
        <AuthPanel />
      </main>
    );
  }
  const cookieHeader = `walkz_session=${encodeURIComponent(session)}`;
  const installationResult = await Promise.allSettled([
    loadDashboardInstallations(process.env.WALKZ_API_URL, cookieHeader),
  ]);
  const installationState = installationResult[0];
  if (installationState.status === 'rejected') {
    return (
      <main className="shell">
        <Hero />
        <InstallationError />
      </main>
    );
  }
  if (installationState.value === null) {
    return (
      <main className="shell">
        <Hero />
        <AuthPanel expired />
      </main>
    );
  }
  const installations = installationState.value;
  const selectedRepository = installations
    .flatMap((installation) => installation.repositories)
    .find((repository) => repository.selectedRepositoryId !== null);
  if (selectedRepository?.selectedRepositoryId === undefined || selectedRepository.selectedRepositoryId === null) {
    return (
      <main className="shell">
        <Hero />
        <RepositoryPicker installations={installations} />
      </main>
    );
  }
  const [credentialStatus, reviewHistory, configurationHistory] = await Promise.allSettled([
    loadProviderCredentialStatus(
      process.env.WALKZ_API_URL,
      selectedRepository.selectedRepositoryId,
      cookieHeader || undefined,
    ),
    loadDashboardReviews(
      process.env.WALKZ_API_URL,
      selectedRepository.selectedRepositoryId,
      cookieHeader || undefined,
    ),
    loadDashboardConfigurations(
      process.env.WALKZ_API_URL,
      selectedRepository.selectedRepositoryId,
      cookieHeader || undefined,
    ),
  ]);
  const reviews: DashboardReview[] = reviewHistory.status === 'fulfilled' ? reviewHistory.value : [];
  const configurations: DashboardConfiguration[] = configurationHistory.status === 'fulfilled'
    ? configurationHistory.value
    : [];
  return (
    <main className="shell">
      <Hero />
      <p className="repository-context">
        Repository <strong>{selectedRepository.owner}/{selectedRepository.name}</strong>
      </p>
      <ProviderCredentialForm
        key={selectedRepository.selectedRepositoryId}
        repositoryId={selectedRepository.selectedRepositoryId}
        initialConnected={credentialStatus.status === 'fulfilled' && credentialStatus.value.connected}
        statusUnavailable={credentialStatus.status === 'rejected'}
      />
      <section aria-labelledby="recent-reviews">
        <div className="section-heading">
          <h2 id="recent-reviews">Recent reviews</h2>
          <span className="badge">Read only</span>
        </div>
        {reviewHistory.status === 'rejected' ? (
          <p className="empty-state">Review history is temporarily unavailable. Try again later.</p>
        ) : (
          <ReviewHistory initialReviews={reviews} />
        )}
      </section>
      <section aria-labelledby="configuration-history">
        <div className="section-heading">
          <h2 id="configuration-history">Configuration history</h2>
          <span className="badge">Metadata only</span>
        </div>
        <ConfigurationHistory
          configurations={configurations}
          unavailable={configurationHistory.status === 'rejected'}
        />
      </section>
    </main>
  );
}
