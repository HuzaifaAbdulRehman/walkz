import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProviderCredentialForm } from './provider-credential-form.js';

describe('provider credential form', () => {
  it('renders an empty password field for a disconnected repository', () => {
    const html = renderToStaticMarkup(createElement(ProviderCredentialForm, {
      repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      initialConnected: false,
    }));

    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('Connect Groq');
    expect(html).toContain('Not connected');
    expect(html).not.toContain('gsk_');
  });

  it('offers guarded removal for a connected repository', () => {
    const html = renderToStaticMarkup(createElement(ProviderCredentialForm, {
      repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      initialConnected: true,
    }));

    expect(html).toContain('Connected');
    expect(html).toContain('Replace key');
    expect(html).toContain('Remove key');
    expect(html).not.toContain('Confirm removal');
  });
});
