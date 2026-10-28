import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup-home.ts'],
    // Several suites run real git against temp repos; on a Windows host busy with other apps they pass, but slowly, so tests and hooks get room.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // Real git runs slow down sharply when many files share the disk at once: fewer workers keep each test well inside its limit.
    maxWorkers: 4,
  },
});
