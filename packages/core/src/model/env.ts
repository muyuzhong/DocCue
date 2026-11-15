import { createAnthropic, type AnthropicEffort } from './anthropic.js';
import { createOpenAI } from './openai.js';
import type { ModelAdapter } from './types.js';

export type ModelEnv = Record<string, string | undefined>;

/**
 * Builds a model adapter from environment-style settings (e.g. `process.env`):
 * DOCCUE_PROVIDER (anthropic | openai), DOCCUE_MODEL, DOCCUE_BASE_URL, DOCCUE_EFFORT,
 * DOCCUE_MAX_TOKENS, DOCCUE_PROMPT_CACHE (on | off), ANTHROPIC_API_KEY, OPENAI_API_KEY. Empty
 * values count as unset. Throws when something required is missing or not understood.
 */
export function createModelFromEnv(env: ModelEnv): ModelAdapter {
  const get = (name: string) => env[name]?.trim() || undefined;
  const provider = get('DOCCUE_PROVIDER') ?? (get('ANTHROPIC_API_KEY') ? 'anthropic' : get('OPENAI_API_KEY') || get('DOCCUE_BASE_URL') ? 'openai' : undefined);
  const baseURL = get('DOCCUE_BASE_URL');
  const maxTokens = Number(get('DOCCUE_MAX_TOKENS'));
  const base = { ...(baseURL ? { baseURL } : {}), ...(maxTokens > 0 ? { maxTokens } : {}) };
  // Prompt caching is on by default only for Anthropic's own endpoint; a gateway that passes it
  // through can turn it on.
  const cache = get('DOCCUE_PROMPT_CACHE')?.toLowerCase();
  if (cache !== undefined && !['on', 'off'].includes(cache)) throw new Error(`DOCCUE_PROMPT_CACHE 只能是 on 或 off（现在是 ${cache}）`);
  if (provider === 'anthropic') {
    const apiKey = get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY');
    const effort = get('DOCCUE_EFFORT');
    return createAnthropic({
      apiKey,
      model: get('DOCCUE_MODEL') ?? 'claude-opus-5-5',
      ...base,
      ...(effort ? { effort: effort as AnthropicEffort } : {}),
      ...(cache ? { promptCache: cache === 'on' } : {}),
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
