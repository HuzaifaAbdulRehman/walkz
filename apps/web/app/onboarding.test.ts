import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AuthPanel, EmptyRepositoryState, InstallationError } from './auth-panel.js';

describe('dashboard onboarding', () => {
  it('gives signed-out users a real GitHub authorization link', () => {
    const html = renderToStaticMarkup(createElement(AuthPanel));

    expect(html).toContain('href="/auth/github/start"');
    expect(html).toContain('Sign in with GitHub');
  });

  it('gives installation failures a retry action', () => {
    const html = renderToStaticMarkup(createElement(InstallationError));

    expect(html).toContain('href="/"');
    expect(html).toContain('Try again');
  });

  it('gives an empty installation a sign-in recovery action', () => {
    const html = renderToStaticMarkup(createElement(EmptyRepositoryState));

    expect(html).toContain('href="/auth/github/start"');
    expect(html).toContain('Sign in again');
  });
});
