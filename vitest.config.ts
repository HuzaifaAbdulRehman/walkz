import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 15_000,
    include: ['{apps,packages}/**/*.test.ts', 'scripts/**/*.test.mjs'],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
