export function AuthPanel({ expired = false }: { expired?: boolean }) {
  return (
    <section aria-labelledby="connect-github">
      <div className="setup-card">
        <p className="configuration-label">GitHub access</p>
        <h2 id="connect-github">{expired ? 'Sign in again' : 'Connect GitHub'}</h2>
        <p className="setup-copy">
          {expired
            ? 'Your Walkz session has expired. Sign in again to continue.'
            : 'Sign in to load the repositories where you installed Walkz.'}
        </p>
        <a className="primary-action" href="/auth/github/start">
          Sign in with GitHub
        </a>
      </div>
    </section>
  );
}

export function InstallationError() {
  return (
    <section aria-labelledby="installation-error">
      <div className="setup-card">
        <p className="configuration-label">GitHub access</p>
        <h2 id="installation-error">Installation lookup failed</h2>
        <p className="setup-copy">
          Walkz could not load the GitHub installation. Check the API and try again.
        </p>
        <a className="secondary-action" href="/">Try again</a>
      </div>
    </section>
  );
}

export function EmptyRepositoryState() {
  return (
    <>
      <p className="setup-copy">
        No repositories are available. Check the GitHub App installation, then sign in again.
      </p>
      <a className="secondary-action" href="/auth/github/start">
        Sign in again
      </a>
    </>
  );
}
