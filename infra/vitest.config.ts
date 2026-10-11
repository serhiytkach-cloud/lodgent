import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Synthesizing the full app takes a few seconds per variant.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
