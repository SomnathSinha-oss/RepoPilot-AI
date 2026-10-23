import React, { useState } from 'react';
import './App.css';

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(''); // "" | "review" | "roadmap"
  const [error, setError] = useState('');
  const [repository, setRepository] = useState(null);
  const [review, setReview] = useState(null);
  const [roadmap, setRoadmap] = useState(null);

  const analyze = async (mode) => {
    if (!url || !url.trim()) {
      setError('Please provide a valid GitHub repository URL.');
      return;
    }

    setError('');
    setLoading(mode);

    try {
      const endpoint = mode === 'roadmap' ? '/api/roadmap' : '/api/review';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Server responded with status ${response.status}`);
      }

      if (data.repository) {
        setRepository(data.repository);
      }

      if (mode === 'review') {
        setReview(data.review);
      } else if (mode === 'roadmap') {
        if (data.review) {
          setReview(data.review);
        }
        setRoadmap(data.roadmap);
      }
    } catch (err) {
      setError(err.message || 'Failed to analyze repository. Please try again.');
    } finally {
      setLoading('');
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    analyze('review');
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">⚡</div>
          <span className="brand-name">RepoPilot AI</span>
        </div>
        <div className="topbar-tagline">Autonomous Repository Intelligence</div>
      </header>

      <section className="hero">
        <h1>Autonomous Code Review &amp; <span>Engineering Roadmaps</span></h1>
        <p className="subtitle">
          Accelerate code reviews and architecture planning. Inspect public codebases with
          Google Gemma and transform findings into prioritized engineering roadmaps using Gemini.
        </p>

        <form className="repo-form" onSubmit={handleSubmit}>
          <div className="input-row">
            <label htmlFor="github-repo-url" className="sr-only">
              GitHub Repository URL
            </label>
            <input
              id="github-repo-url"
              type="url"
              className="repo-input"
              placeholder="https://github.com/owner/repository"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading !== ''}
              required
              aria-label="GitHub Repository URL"
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading !== ''}
              aria-busy={loading === 'review'}
            >
              Review with Gemma ↗
            </button>
          </div>
        </form>
      </section>

      {error && (
        <div className="alert-box error-alert" role="alert">
          <span className="alert-icon" aria-hidden="true">⚠️</span>
          <div className="alert-content">
            <strong>Error:</strong> {error}
          </div>
        </div>
      )}

      {loading && (
        <div className="loading-state" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <span className="loading-text">
            {loading === 'roadmap'
              ? 'Analyzing review findings & synthesizing roadmap with Gemini...'
              : 'Fetching repository files & reviewing architecture with Gemma...'}
          </span>
        </div>
      )}

      {repository && (
        <section className="results">
          <div className="repo-card">
            <div className="repo-header">
              <h2>
                <a
                  href={repository.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="repo-link"
                >
                  {repository.name}
                </a>
              </h2>
              {repository.stars !== undefined && (
                <span className="badge stars-badge" title="GitHub Stars">
                  ⭐ {Number(repository.stars).toLocaleString()}
                </span>
              )}
            </div>

            <p className="repo-desc">
              {repository.description || 'No description provided for this repository.'}
            </p>

            <div className="repo-meta">
              <span className="meta-item">
                <strong>Language:</strong> {repository.language || 'Unknown'}
              </span>
              <span className="meta-item">
                <strong>Default Branch:</strong> <code>{repository.default_branch || 'main'}</code>
              </span>
              {repository.html_url && (
                <span className="meta-item">
                  <a
                    href={repository.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="meta-link"
                  >
                    View on GitHub ↗
                  </a>
                </span>
              )}
            </div>
          </div>

          {review && (
            <article className="report review-report">
              <div className="report-heading">
                <div>
                  <h3>Gemma Code Review</h3>
                  {review.model && (
                    <span className="model-badge">Model: {review.model}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => analyze('roadmap')}
                  disabled={loading !== ''}
                  aria-busy={loading === 'roadmap'}
                >
                  Generate roadmap with Gemini →
                </button>
              </div>
              <pre className="report-content">
                {typeof review === 'string'
                  ? review
                  : review.report || JSON.stringify(review, null, 2)}
              </pre>
            </article>
          )}

          {roadmap && (
            <article className="report roadmap-report">
              <div className="report-heading">
                <div>
                  <h3>Gemini Strategic Roadmap</h3>
                  {roadmap.model && (
                    <span className="model-badge">Model: {roadmap.model}</span>
                  )}
                </div>
              </div>
              <pre className="report-content">
                {typeof roadmap === 'string'
                  ? roadmap
                  : roadmap.roadmap || JSON.stringify(roadmap, null, 2)}
              </pre>
            </article>
          )}
        </section>
      )}

      <footer className="app-footer">
        <p>RepoPilot AI &copy; 2026. Powered by Google Gemma &amp; Gemini models.</p>
      </footer>
    </main>
  );
}
