/**
 * Try one turn against a real model from the command line.
 *
 *   ANTHROPIC_API_KEY=... pnpm try "你好"
 *   DOCCUE_PROVIDER=openai DOCCUE_BASE_URL=http://localhost:11434/v1 DOCCUE_MODEL=qwen3 pnpm try "你好"
 *   pnpm try --tool "现在几点？"      # adds a demo tool to exercise the multi-step loop
 *
 * Model settings come from environment variables (see env-model.ts).
 */
import { runTurn, withRetry, type Tool } from '../src/index.js';
import { MODEL_USAGE, modelFromEnv } from './env-model.js';

const USAGE = `用法：pnpm try [--tool] "问题"
  加 --tool 会挂一个演示工具（查当前时间），用来测多步循环。

${MODEL_USAGE}`;

const argv = process.argv.slice(2);
const useTool = argv.includes('--tool');
const question = argv.filter((arg) => arg !== '--tool').join(' ') || '用一句话介绍你自己。';

/** Demo only, to exercise the loop. Not part of the project's tools. */
const currentTime: Tool = {
  name: 'get_current_time',
  description: 'Returns the current date and time.',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai' } },
  },
  async execute(args) {
    const timezone = (args as { timezone?: unknown }).timezone;
    return new Date().toLocaleString('zh-CN', { timeZone: typeof timezone === 'string' ? timezone : 'Asia/Shanghai' });
  },
};

const model = modelFromEnv(USAGE);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
console.log(`[${model.provider} / ${model.model}] ${question}\n`);

for await (const event of runTurn({
  model: withRetry(model, {
    onRetry: (error, attempt, delayMs) => console.error(`\n[第 ${attempt} 次重试，${Math.round(delayMs)}ms 后] ${error.message}`),
  }),
  system: "You are a helpful assistant inside a web app. Answer in the user's language.",
  messages: [{ role: 'user', content: question }],
  tools: useTool ? [currentTime] : [],
  signal: controller.signal,
})) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.delta);
      break;
    case 'tool_call':
      console.log(`\n[调用工具] ${event.call.name} ${event.call.rawArgs}`);
      break;
    case 'tool_result':
      console.log(`[工具结果] ${typeof event.result.content === 'string' ? event.result.content : '(多段内容)'}`);
      break;
    case 'step_end':
      if (event.servedBy && event.servedBy !== model.model) console.log(`\n[实际由 ${event.servedBy} 回答]`);
      break;
    case 'turn_end': {
      const { inputTokens, cacheReadTokens, outputTokens } = event.usage;
      console.log(`\n\n[结束：${event.reason}] 输入 ${inputTokens} tokens（缓存命中 ${cacheReadTokens}），输出 ${outputTokens} tokens`);
      if (event.error) console.error(event.error.message);
      process.exitCode = event.reason === 'completed' ? 0 : 1;
      break;
    }
    default:
      break;
  }
}
