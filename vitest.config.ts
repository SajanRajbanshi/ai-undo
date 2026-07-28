import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/perf/**/*.test.ts'],
    // Integration tests shell out to real git against real temp directories.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each file gets its own tmp tree, but git is process-heavy; keep the fan-out sane.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
