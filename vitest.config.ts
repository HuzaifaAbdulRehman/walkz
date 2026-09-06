import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 15_000,
    include: ['packages/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
