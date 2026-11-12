import { defineConfig } from 'vitest/config';

// Load the workspace packages from their TypeScript sources.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
});
