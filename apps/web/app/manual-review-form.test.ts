import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ManualReviewForm } from './manual-review-form.js';

describe('manual review form', () => {
  it('renders a bounded pull request input and idle action', () => {
    const html = renderToStaticMarkup(createElement(ManualReviewForm, {
      repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
    }));

    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="2147483647"');
    expect(html).toContain('Pull request number');
    expect(html).toContain('Run review');
    expect(html).toContain('data-busy="false"');
  });
});
