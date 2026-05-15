import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 10_800_000,  // 3 hours per test — real Claude API calls with Opus
    hookTimeout: 300_000,     // 5 min for setup/teardown (daemon boot)
    sequence: {
      concurrent: false,      // sequential — shared JIRA project + API rate limits
    },
    fileParallelism: false,
  },
});
