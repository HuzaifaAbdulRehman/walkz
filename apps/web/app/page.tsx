const reviews = [
  { repository: 'demo/repository', pullRequest: '#42', status: 'INCONCLUSIVE', detail: 'Hosted review history is not connected yet.' },
  { repository: 'demo/repository', pullRequest: '#41', status: 'SHIP', detail: 'No blocking evidence.' },
];

export default function HomePage() {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">WALKZ / REVIEW DASHBOARD</p>
        <h1>Evidence before merge.</h1>
        <p className="lede">Walkz separates model suggestions from deterministic review evidence.</p>
      </header>
      <section aria-labelledby="recent-reviews">
        <div className="section-heading">
          <h2 id="recent-reviews">Recent reviews</h2>
          <span className="badge">Read only</span>
        </div>
        <div className="review-list">
          {reviews.map((review) => (
            <article className="review-card" key={`${review.repository}-${review.pullRequest}`}>
              <div>
                <p className="repository">{review.repository}</p>
                <h3>{review.pullRequest}</h3>
                <p className="detail">{review.detail}</p>
              </div>
              <span className={`status status-${review.status.toLowerCase()}`}>{review.status}</span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
