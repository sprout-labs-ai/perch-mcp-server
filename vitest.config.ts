import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The stdio e2e test spawns a child process via tsx; give it room.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points: exercised end-to-end by tests/stdio-e2e.test.ts
      // in a child process, which in-process v8 coverage can't see.
      exclude: ['src/index.ts', 'src/transport/stdio.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 98,
        statements: 98,
        functions: 95,
        branches: 95,
      },
    },
  },
});
