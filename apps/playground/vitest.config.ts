import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Load the workspace packages from their TypeScript sources.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  // Real browser, real model: run tests side by side, and give them time.
  test: { include: ['test/**/*.test.ts'], testTimeout: 240_000, hookTimeout: 60_000, sequence: { concurrent: true } },
});
