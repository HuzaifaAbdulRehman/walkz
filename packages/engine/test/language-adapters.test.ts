import { describe, expect, it } from 'vitest';

import {
  getReviewLanguageAdapter,
  listReviewLanguageAdapters,
  resolveReviewLanguageAdapters,
} from '../src/index.js';

describe('review language adapters', () => {
  it('resolves mixed repositories in stable registry order', () => {
    expect(resolveReviewLanguageAdapters([
      'service/main.PY',
      'web/component.tsx',
      'README.md',
    ]).map((adapter) => adapter.id)).toEqual([
      'javascript-typescript',
      'python',
    ]);
  });

  it('does not guess a language for unknown extensions', () => {
    expect(resolveReviewLanguageAdapters(['Dockerfile', 'README.md']))
      .toEqual([]);
  });

  it('binds each language to a distinct pinned proof runtime', () => {
    const javascript = getReviewLanguageAdapter('javascript-typescript');
    const python = getReviewLanguageAdapter('python');

    expect(javascript.proofRuntime).toMatchObject({
      command: { executable: 'node' },
      reproducerPath: '.walkz-proof/reproducer.mjs',
    });
    expect(python.proofRuntime).toMatchObject({
      command: {
        executable: 'python',
        args: [
          '-B',
          '-c',
          "import runpy; runpy.run_path('.walkz-proof/reproducer.py', run_name='__main__')",
        ],
      },
      reproducerPath: '.walkz-proof/reproducer.py',
    });
    expect(javascript.proofRuntime.defaultContainerImage)
      .toMatch(/^node@sha256:[a-f0-9]{64}$/);
    expect(python.proofRuntime.defaultContainerImage)
      .toMatch(/^python@sha256:[a-f0-9]{64}$/);
    expect(listReviewLanguageAdapters()).toHaveLength(2);
  });
});
