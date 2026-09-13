import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FindingFeedbackControls } from './finding-feedback-controls.js';

describe('finding feedback controls', () => {
  it('renders two equally prominent labeled actions', () => {
    const html = renderToStaticMarkup(createElement(FindingFeedbackControls, {
      repositoryId: 'repository',
      reviewRunId: 'review',
      findingId: 'finding',
    }));

    expect(html).toContain('Was this finding right?');
    expect(html).toContain('Correct');
    expect(html).toContain('False positive');
    expect(html.match(/class="secondary-action"/g)).toHaveLength(2);
  });
});
