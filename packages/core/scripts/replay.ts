/**
 * Re-send a logged model call, to reproduce or compare an answer.
 *
 *   pnpm replay <log.jsonl>          list the model calls in a log
 *   pnpm replay <log.jsonl> <n>      send call n again to the model configured by environment
 *                                    variables (see env-model.ts) and print both answers
 */
import { readFileSync } from 'node:fs';
import type { AssistantMessage, LogRecord, ModelCallRecord } from '../src/index.js';
import { MODEL_USAGE, fail, modelFromEnv } from './env-model.js';

const USAGE = `用法：
  pnpm replay <日志文件>          列出日志里的模型调用
  pnpm replay <日志文件> <编号>   把这一次调用原样重发给模型，对比前后两次回答

${MODEL_USAGE}`;

const [file, which] = process.argv.slice(2);
if (!file) fail('缺少日志文件', USAGE);

const calls = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as LogRecord)
  .filter((record): record is ModelCallRecord & { turnId?: string; step?: number } => record.kind === 'model_call');

const textOf = (message: AssistantMessage | undefined) =>
  message?.content.map((part) => (part.type === 'text' ? part.text : part.type === 'tool_call' ? `[调用 ${part.name} ${part.rawArgs}]` : '')).join('') ?? '';

if (which === undefined) {
  if (calls.length === 0) console.log('日志里没有模型调用。');
  calls.forEach((call, i) => {
    const outcome = call.error ? `出错：${call.error.message}` : textOf(call.result?.message).replace(/\n/g, ' ').slice(0, 60);
    const first = call.firstOutputMs === undefined ? '' : `首字 ${call.firstOutputMs}ms，`;
    console.log(`#${i}  ${new Date(call.at).toLocaleString('zh-CN')}  ${call.model}  ${first}耗时 ${call.durationMs}ms  ${call.request.messages.length} 条消息  ${outcome}`);
  });
} else {
  const call = calls[Number(which)] ?? fail(`没有编号 ${which} 的调用（共 ${calls.length} 次）`, USAGE);
  const model = modelFromEnv(USAGE);
  console.log(`[原来：${call.model}]\n${call.error ? `出错：${call.error.message}` : textOf(call.result?.message)}\n`);
  console.log(`[重发：${model.model}]`);
  const started = Date.now();
  for await (const event of model.stream(call.request)) {
    if (event.type === 'text') process.stdout.write(event.delta);
    if (event.type === 'done') {
      const calls = event.message.content.filter((part) => part.type === 'tool_call');
      for (const tool of calls) process.stdout.write(`\n[调用 ${tool.name} ${tool.rawArgs}]`);
      console.log(`\n\n[${event.stopReason}；${Date.now() - started}ms；输入 ${event.usage.inputTokens}，输出 ${event.usage.outputTokens} tokens]`);
    }
  }
}
