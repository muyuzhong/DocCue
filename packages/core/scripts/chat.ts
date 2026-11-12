/**
 * Multi-turn chat from the command line, playing the frontend's part: it keeps the conversation,
 * and commands simulate what the bridge would report, so the prompt and the rendering can be
 * tried with a real model without a browser.
 *
 *   ANTHROPIC_API_KEY=... pnpm chat
 *
 * Type a message and press Enter. Ctrl-C stops the current answer; Ctrl-C when idle (or Ctrl-D)
 * exits. `/help` lists commands. Every request and model call is logged to packages/core/.logs/
 * as JSON lines (replay a call with `pnpm replay`); DOCCUE_LOG=off turns that off.
 * Model settings come from environment variables (see env-model.ts).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import readline from 'node:readline';
import {
  PROTOCOL_VERSION,
  renderLastUserMessage,
  respond,
  toJsonLine,
  withRetry,
  type ActionType,
  type Item,
  type Logger,
  type Perception,
  type ScreenNode,
  type TimelineEntry,
} from '../src/index.js';
import { MODEL_USAGE, modelFromEnv } from './env-model.js';

const HELP = `命令（模拟界面上发生的事，下一次提问时模型会看到）：
  /page <路径> [标题]                          进入页面，如 /page /datasource/new 新建数据源
  /do <动作> <角色> <名字> [= 值] [-> 报错]     一次操作，如 /do input textbox 主机地址 = http://127.0.0.1
                                               /do click button 测试连接 -> Invalid Host Format
  /context                                     看下一次提问会带上的现场信息
  /reset                                       开始新对话`;

const model = modelFromEnv(`用法：pnpm chat\n\n${MODEL_USAGE}`);

function fileLogger(): { logger: Logger; path: string } | undefined {
  if (process.env.DOCCUE_LOG === 'off') return undefined;
  const dir = new URL('../.logs/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = new URL(`chat-${stamp}.jsonl`, dir);
  return { path: file.pathname, logger: (record) => appendFileSync(file, `${toJsonLine(record)}\n`) };
}

const log = fileLogger();
const options = { model: withRetry(model), ...(log ? { logger: log.logger } : {}) };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你：' });

// What the simulated frontend holds.
let conversation: Item[] = [];
let page = { path: '/', title: '' };
let controls: ScreenNode[] = [];
let actions: TimelineEntry[] = [];
let running: AbortController | undefined;

function perceive(): Perception {
  const nodes = controls.map((node, index) => ({ ...(node.role === 'alert' ? {} : { ref: index + 1 }), ...node }));
  return { at: Date.now(), screen: { page: { path: page.path, ...(page.title ? { title: page.title } : {}) }, nodes }, actions };
}

function runCommand(line: string): void {
  const [command = '', ...words] = line.split(/\s+/);
  const rest = line.slice(command.length).trim();
  switch (command) {
    case '/help':
      return console.log(HELP);
    case '/page': {
      if (!words[0]) return console.log('用法：/page <路径> [标题]');
      page = { path: words[0], title: words.slice(1).join(' ') };
      controls = [];
      actions.push({ at: Date.now(), effects: [{ type: 'navigate', page: { path: page.path, ...(page.title ? { title: page.title } : {}) } }] });
      return console.log('[已记录：进入页面]');
    }
    case '/do': {
      const [head = '', error] = rest.split(/\s+->\s+/, 2);
      const [what = '', value] = head.split(/\s+=\s+/, 2);
      const [type, role, ...nameWords] = what.trim().split(/\s+/);
      if (!type || !role) return console.log('用法：/do <动作> <角色> <名字> [= 值] [-> 报错]');
      const name = nameWords.join(' ');
      let node = controls.find((control) => control.role === role && control.name === name);
      if (!node) controls.push((node = { role, name }));
      if (value !== undefined) node.value = value;
      if (error) controls.push({ role: 'alert', name: error });
      actions.push({
        at: Date.now(),
        action: { type: type as ActionType, target: { role, name }, ...(value === undefined ? {} : { value }) },
        ...(error ? { effects: [{ type: 'error', text: error }] } : {}),
      });
      return console.log('[已记录：操作]');
    }
    case '/context':
      return console.log(renderLastUserMessage({ conversation: [{ type: 'user', text: '（你的问题）', perception: perceive() }] }));
    case '/reset':
      conversation = [];
      return console.log('[已开始新对话]');
    default:
      console.log(`不认识的命令 ${command}，输入 /help 查看。`);
  }
}

async function ask(text: string): Promise<void> {
  conversation.push({ type: 'user', text, perception: perceive() });
  actions = [];
  running = new AbortController();
  process.stdout.write('\n助手：');
  for await (const event of respond({ v: PROTOCOL_VERSION, conversation, locale: 'zh-CN' }, options, running.signal)) {
    if (event.type === 'text') process.stdout.write(event.delta);
    else if (event.type === 'status' && event.state === 'tool') process.stdout.write(`\n[调用工具 ${event.tool}]\n`);
    else if (event.type === 'end') {
      if (event.item.type === 'model' && event.item.messages.length > 0) conversation.push(event.item);
      const { inputTokens, cacheReadTokens, outputTokens } = event.usage;
      const error = event.error ? `：${event.error.message}` : '';
      process.stdout.write(`\n[${event.reason}${error}；输入 ${inputTokens}（缓存 ${cacheReadTokens}），输出 ${outputTokens} tokens]\n`);
    }
  }
  running = undefined;
}

// Lines are handled one after another, so input typed (or piped in) during an answer waits its turn.
let queue: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  const text = line.trim();
  queue = queue
    .then(() => (text.startsWith('/') ? runCommand(text) : text ? ask(text) : undefined))
    .catch((error: unknown) => console.error(`[错误] ${error instanceof Error ? error.message : String(error)}`))
    .then(() => rl.prompt());
});

rl.on('SIGINT', () => {
  if (running) running.abort();
  else rl.close();
});

rl.on('close', () => void queue.then(() => process.exit(0)));

console.log(`[${model.provider} / ${model.model}] 输入问题回车发送；回答中 Ctrl-C 停止；/help 查看模拟界面的命令。`);
if (log) console.log(`[日志] ${log.path}`);
rl.prompt();
