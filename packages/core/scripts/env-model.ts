/**
 * Builds the model for the scripts in this folder from the repository's root `.env` and the
 * environment (variables already set in the environment win). See .env.example.
 */
import { existsSync } from 'node:fs';
import { createModelFromEnv, type ModelAdapter } from '../src/index.js';

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

export function modelFromEnv(usage: string = MODEL_USAGE): ModelAdapter {
  try {
    return createModelFromEnv(process.env);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), usage);
  }
}
