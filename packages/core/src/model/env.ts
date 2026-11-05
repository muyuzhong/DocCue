import { createAnthropic, type AnthropicEffort } from './anthropic.js';
import { createOpenAI } from './openai.js';
import type { ModelAdapter } from './types.js';

export type ModelEnv = Record<string, string | undefined>;

/**
 * Builds a model adapter from environment-style settings (e.g. `process.env`):
 * DOCCUE_PROVIDER (anthropic | openai), DOCCUE_MODEL, DOCCUE_BASE_URL, DOCCUE_EFFORT,
 * ANTHROPIC_API_KEY, OPENAI_API_KEY. Empty values count as unset. Throws when something
 * required is missing.
 */
export function createModelFromEnv(env: ModelEnv): ModelAdapter {
  const get = (name: string) => env[name]?.trim() || undefined;
  const provider = get('DOCCUE_PROVIDER') ?? (get('ANTHROPIC_API_KEY') ? 'anthropic' : get('OPENAI_API_KEY') || get('DOCCUE_BASE_URL') ? 'openai' : undefined);
  const baseURL = get('DOCCUE_BASE_URL');
  const base = baseURL ? { baseURL } : {};
  if (provider === 'anthropic') {
    const apiKey = get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY');
    const effort = get('DOCCUE_EFFORT');
    return createAnthropic({
      apiKey,
      model: get('DOCCUE_MODEL') ?? 'claude-opus-5-5',
      ...base,
      ...(effort ? { effort: effort as AnthropicEffort } : {}),
    });
  }
  if (provider === 'openai') {
    const model = get('DOCCUE_MODEL');
    if (!model) throw new Error('缺少 DOCCUE_MODEL');
    const apiKey = get('OPENAI_API_KEY');
    return createOpenAI({ model, ...base, ...(apiKey ? { apiKey } : {}) });
  }
  throw new Error(`不知道用哪个模型：请设置 ANTHROPIC_API_KEY，或 DOCCUE_PROVIDER=openai${provider ? `（不认识 DOCCUE_PROVIDER=${provider}）` : ''}`);
}
