import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Transfers are exercised with microtask-scale timers, so give the slower
    // backpressure cases room without letting a hang block the suite.
    testTimeout: 30_000
  }
});
