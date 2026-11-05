/**
 * Builds a model adapter from environment variables, for the scripts in this folder.
 * The repository's root `.env` is read first (variables already set in the environment win).
 *
 * DOCCUE_PROVIDER (anthropic | openai), DOCCUE_MODEL, DOCCUE_BASE_URL,
 * DOCCUE_EFFORT (Anthropic: low | medium | high | xhigh | max), ANTHROPIC_API_KEY, OPENAI_API_KEY.
 */
import { existsSync } from 'node:fs';
import { createAnthropic, createOpenAI, type AnthropicEffort, type ModelAdapter } from '../src/index.js';

const ENV_FILE = new URL('../../../.env', import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const MODEL_USAGE = `模型配置（写在仓库根目录的 .env 里，参考 .env.example；也可以直接设环境变量）：
  ANTHROPIC_API_KEY=...                         用 Anthropic，默认模型 claude-opus-5-5
  DOCCUE_PROVIDER=openai DOCCUE_MODEL=模型名     用 OpenAI 兼容接口（本地模型再加 DOCCUE_BASE_URL）
  可选：DOCCUE_MODEL、DOCCUE_BASE_URL、DOCCUE_EFFORT、OPENAI_API_KEY`;

export function fail(message: string, usage: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

/** An environment variable, with empty values (common in .env files) treated as unset. */
function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function modelFromEnv(usage: string = MODEL_USAGE): ModelAdapter {
  const provider = env('DOCCUE_PROVIDER') ?? (env('ANTHROPIC_API_KEY') ? 'anthropic' : env('OPENAI_API_KEY') || env('DOCCUE_BASE_URL') ? 'openai' : undefined);
  const baseURL = env('DOCCUE_BASE_URL');
  const base = baseURL ? { baseURL } : {};
  if (provider === 'anthropic') {
    const apiKey = env('ANTHROPIC_API_KEY') ?? fail('缺少 ANTHROPIC_API_KEY', usage);
    const effort = env('DOCCUE_EFFORT');
    return createAnthropic({
      apiKey,
      model: env('DOCCUE_MODEL') ?? 'claude-opus-5-5',
      ...base,
      ...(effort ? { effort: effort as AnthropicEffort } : {}),
    });
  }
  if (provider === 'openai') {
    const model = env('DOCCUE_MODEL') ?? fail('缺少 DOCCUE_MODEL', usage);
    const apiKey = env('OPENAI_API_KEY');
    return createOpenAI({ model, ...base, ...(apiKey ? { apiKey } : {}) });
  }
  return fail('不知道用哪个模型：请在 .env 里设置 ANTHROPIC_API_KEY，或 DOCCUE_PROVIDER=openai。', usage);
}
