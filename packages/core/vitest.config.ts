import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Load the workspace packages from their TypeScript sources.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  // Most tests call the real model: run them side by side, and give them time.
  test: { testTimeout: 120_000, sequence: { concurrent: true } },
});
