/**
 * Multi-turn chat through the scheduler, to try sessions and the event queue with a real model.
 *
 *   ANTHROPIC_API_KEY=... pnpm chat
 *
 * Type a message and press Enter. You can keep typing while an answer streams: the message is
 * queued and answered next. Ctrl-C stops the current answer; Ctrl-C when idle (or Ctrl-D) exits.
 * `/history` prints what the session has stored.
 *
 * Model settings come from environment variables (see env-model.ts).
 */
import readline from 'node:readline';
import { createScheduler, plainContext, withRetry } from '../src/index.js';
import { MODEL_USAGE, modelFromEnv } from './env-model.js';

const SESSION = 'cli';
const model = modelFromEnv(`用法：pnpm chat\n\n${MODEL_USAGE}`);
const scheduler = createScheduler({
  model: withRetry(model),
  context: plainContext("You are a helpful assistant inside a web app. Answer in the user's language."),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你：' });
let busy = false;

scheduler.subscribe(SESSION, (output) => {
  switch (output.type) {
    case 'turn_start':
      busy = true;
      process.stdout.write('\n助手：');
      break;
    case 'text':
      process.stdout.write(output.delta);
      break;
    case 'status':
      if (output.state === 'tool') process.stdout.write(`\n[调用工具 ${output.tool}]\n`);
      break;
    case 'turn_end': {
      busy = false;
      const error = output.error ? `：${output.error.message}` : '';
      process.stdout.write(`\n[${output.reason}${error}，输出 ${output.usage.outputTokens} tokens]\n`);
      rl.prompt();
      break;
    }
    case 'error':
      console.error(`\n[错误] ${output.message}`);
      break;
    default:
      break;
  }
});

async function printHistory(): Promise<void> {
  const session = await scheduler.getSession(SESSION);
  const history = session?.history ?? [];
  console.log(`[会话里存了 ${history.length} 条消息]`);
  for (const message of history) {
    if (message.role === 'user') {
      console.log(`  用户：${typeof message.content === 'string' ? message.content : '(多段内容)'}`);
    } else if (message.role === 'assistant') {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : part.type === 'tool_call' ? `[调用 ${part.name}]` : '')).join('');
      console.log(`  助手：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
    } else {
      console.log(`  工具结果 ×${message.results.length}`);
    }
  }
  rl.prompt();
}

rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/history') {
    void printHistory();
    return;
  }
  if (!text) {
    rl.prompt();
    return;
  }
  void scheduler.push(SESSION, { type: 'user_message', content: text }).catch(() => {});
});

rl.on('SIGINT', () => {
  if (busy) void scheduler.push(SESSION, { type: 'cancel' });
  else rl.close();
});

rl.on('close', () => {
  // Let queued questions finish before exiting (matters when input is piped in).
  void scheduler.idle(SESSION).then(() => process.exit(0));
});

console.log(`[${model.provider} / ${model.model}] 输入问题回车发送；回答中 Ctrl-C 停止；/history 查看会话记录。`);
rl.prompt();
