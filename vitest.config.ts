import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 2_400_000, // 40 min per test — Sonnet + multi-warden cascades take time
    hookTimeout: 60_000,
    sequence: {
      concurrent: false, // run sequentially — tests share API rate limits
    },
    fileParallelism: false,
  },
});
