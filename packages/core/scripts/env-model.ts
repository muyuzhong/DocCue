/**
 * Builds a model adapter from environment variables, for the scripts in this folder.
 *
 * DOCCUE_PROVIDER (anthropic | openai), DOCCUE_MODEL, DOCCUE_BASE_URL,
 * DOCCUE_EFFORT (Anthropic: low | medium | high | xhigh | max), ANTHROPIC_API_KEY, OPENAI_API_KEY.
 */
import { createAnthropic, createOpenAI, type AnthropicEffort, type ModelAdapter } from '../src/index.js';

export const MODEL_USAGE = `模型配置（环境变量）：
  ANTHROPIC_API_KEY=...                         用 Anthropic，默认模型 claude-opus-5-5
  DOCCUE_PROVIDER=openai DOCCUE_MODEL=模型名     用 OpenAI 兼容接口（本地模型再加 DOCCUE_BASE_URL）
  可选：DOCCUE_MODEL、DOCCUE_BASE_URL、DOCCUE_EFFORT、OPENAI_API_KEY`;

export function fail(message: string, usage: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

export function modelFromEnv(usage: string = MODEL_USAGE): ModelAdapter {
  const env = process.env;
  const provider =
    env.DOCCUE_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY || env.DOCCUE_BASE_URL ? 'openai' : undefined);
  const baseURL = env.DOCCUE_BASE_URL ? { baseURL: env.DOCCUE_BASE_URL } : {};
  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY ?? fail('缺少 ANTHROPIC_API_KEY', usage);
    const effort = env.DOCCUE_EFFORT ? { effort: env.DOCCUE_EFFORT as AnthropicEffort } : {};
    return createAnthropic({ apiKey, model: env.DOCCUE_MODEL ?? 'claude-opus-5-5', ...baseURL, ...effort });
  }
  if (provider === 'openai') {
    const model = env.DOCCUE_MODEL ?? fail('缺少 DOCCUE_MODEL', usage);
    return createOpenAI({ model, ...baseURL, ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}) });
  }
  return fail('不知道用哪个模型：请设置 ANTHROPIC_API_KEY，或 DOCCUE_PROVIDER=openai。', usage);
}
