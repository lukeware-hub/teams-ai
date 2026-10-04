import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several suites run real git against temp repos; on Windows under load they pass 5 s without being broken.
    testTimeout: 30_000,
  },
});
