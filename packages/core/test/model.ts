/**
 * The real model for tests, from the repository's root .env (see .env.example). Tests that
 * involve the model's behaviour run against it: no fake models.
 */
import { existsSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createModelFromEnv } from '../src/model/env.js';
import { withRetry } from '../src/model/retry.js';
import type { ModelAdapter } from '../src/model/types.js';

// Node gives each address of a host only 250 ms to connect; on a slow link every attempt times out.
setDefaultAutoSelectFamilyAttemptTimeout(2000);
const ENV_FILE = new URL('../../../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** The configured model. `env` overrides settings, e.g. `{ DOCCUE_MAX_TOKENS: '40' }`. */
export function realModel(env: Record<string, string> = {}): ModelAdapter {
  return withRetry(createModelFromEnv({ ...process.env, ...env }));
}

/** The configured model with a key the provider rejects. */
export function rejectedModel(): ModelAdapter {
  return createModelFromEnv({ ...process.env, ANTHROPIC_API_KEY: 'sk-invalid', OPENAI_API_KEY: 'sk-invalid' });
}
