import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 15_000,
    include: ['{apps,packages}/**/*.test.ts'],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
