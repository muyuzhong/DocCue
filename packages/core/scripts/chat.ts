/**
 * Multi-turn chat through the scheduler and the context layer, with commands that simulate what
 * the bridge would report, so the status bar can be tried with a real model before the bridge
 * exists.
 *
 *   ANTHROPIC_API_KEY=... pnpm chat
 *
 * Type a message and press Enter; you can keep typing while an answer streams (it is queued).
 * Ctrl-C stops the current answer; Ctrl-C when idle (or Ctrl-D) exits. `/help` lists commands.
 * Model settings come from environment variables (see env-model.ts).
 */
import readline from 'node:readline';
import { createScheduler, renderStatus, statusContext, withRetry, type ActiveError, type TimelineEntry } from '../src/index.js';
import { MODEL_USAGE, modelFromEnv } from './env-model.js';

const SESSION = 'cli';
const HELP = `命令（模拟界面上发生的事，下一次提问时模型会在状态栏里看到）：
  /page <路径> [标题]                       进入页面，如 /page /datasource/new 新建数据源
  /do <动作> <控件> [= 值] [-> 结果]         一次操作，如 /do click 按钮「测试连接」 -> 出现报错「Invalid Host Format」
  /error [文字]                             页面上出现报错；不带文字则清空报错
  /screen <界面树>                          设置界面树，用 \\n 换行
  /user <键>=<值>                           用户属性，如 /user role=新手
  /tour [<引导id> <第几步> [总步数]]          当前引导；不带参数则清空
  /status                                   看现在的状态栏
  /history                                  看会话里存的消息`;

const model = modelFromEnv(`用法：pnpm chat\n\n${MODEL_USAGE}`);
const scheduler = createScheduler({ model: withRetry(model), context: statusContext() });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你：' });
let busy = false;
let errors: ActiveError[] = [];

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
      const { inputTokens, cacheReadTokens, outputTokens } = output.usage;
      process.stdout.write(`\n[${output.reason}${error}；输入 ${inputTokens}（缓存 ${cacheReadTokens}），输出 ${outputTokens} tokens]\n`);
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

function parseAction(text: string): TimelineEntry | undefined {
  const [head = '', result] = text.split(/\s*->\s*/, 2);
  const [action = '', value] = head.split(/\s+=\s+/, 2);
  const [kind, ...target] = action.trim().split(/\s+/);
  if (!kind) return undefined;
  return {
    at: Date.now(),
    kind,
    ...(target.length > 0 ? { target: target.join(' ') } : {}),
    ...(value === undefined ? {} : { value }),
    ...(result ? { result } : {}),
  };
}

async function showStatus(): Promise<void> {
  const session = await scheduler.getSession(SESSION);
  const status = session ? renderStatus(session) : undefined;
  console.log(status ? `<status>\n${status}\n</status>` : '（还没有任何界面信息）');
  if (session?.perception.screen) console.log(`<screen>\n${session.perception.screen.text}\n</screen>`);
}

async function showHistory(): Promise<void> {
  const history = (await scheduler.getSession(SESSION))?.history ?? [];
  console.log(`[会话里存了 ${history.length} 条消息]`);
  for (const message of history) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.map((p) => (p.type === 'text' ? p.text : '[图片]')).join(' ');
      console.log(`  用户：${text.replace(/\n/g, ' ⏎ ').slice(0, 100)}`);
    } else if (message.role === 'assistant') {
      const text = message.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_call' ? `[调用 ${p.name}]` : '')).join('');
      console.log(`  助手：${text.replace(/\n/g, ' ').slice(0, 100)}`);
    } else {
      console.log(`  工具结果 ×${message.results.length}`);
    }
  }
}

async function runCommand(line: string): Promise<void> {
  const [command = '', ...words] = line.split(/\s+/);
  const rest = line.slice(command.length).trim();
  const push = (event: Parameters<typeof scheduler.push>[1]) => scheduler.push(SESSION, event);
  switch (command) {
    case '/help':
      console.log(HELP);
      return;
    case '/page':
      if (!words[0]) return console.log('用法：/page <路径> [标题]');
      await push({
        type: 'perception',
        page: { path: words[0], ...(words[1] ? { title: words.slice(1).join(' ') } : {}) },
        timeline: [{ at: Date.now(), kind: 'navigate', page: words.slice(1).join(' ') || words[0] }],
      });
      return console.log('[已记录：进入页面]');
    case '/do': {
      const entry = parseAction(rest);
      if (!entry) return console.log('用法：/do <动作> <控件> [= 值] [-> 结果]');
      await push({ type: 'perception', timeline: [entry] });
      return console.log('[已记录：操作]');
    }
    case '/error':
      errors = rest ? [...errors, { text: rest }] : [];
      await push({ type: 'perception', errors });
      return console.log(rest ? '[已记录：报错]' : '[已清空报错]');
    case '/screen':
      await push({ type: 'perception', screen: rest.replace(/\\n/g, '\n') });
      return console.log('[已记录：界面树]');
    case '/user': {
      const [key, ...value] = rest.split('=');
      if (!key || value.length === 0) return console.log('用法：/user <键>=<值>');
      await push({ type: 'user_info', attributes: { [key.trim()]: value.join('=').trim() } });
      return console.log('[已记录：用户属性]');
    }
    case '/tour': {
      const [id, step, total] = words;
      await push({
        type: 'user_info',
        activeTour: id && step ? { id, step: Number(step), ...(total ? { total: Number(total) } : {}) } : null,
      });
      return console.log(id ? '[已记录：当前引导]' : '[已清空当前引导]');
    }
    case '/status':
      return showStatus();
    case '/history':
      return showHistory();
    default:
      console.log(`不认识的命令 ${command}，输入 /help 查看。`);
  }
}

rl.on('line', (line) => {
  const text = line.trim();
  if (text.startsWith('/')) {
    void runCommand(text)
      .catch((error: unknown) => console.error(`[错误] ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (!busy) rl.prompt();
      });
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

console.log(`[${model.provider} / ${model.model}] 输入问题回车发送；回答中 Ctrl-C 停止；/help 查看模拟界面的命令。`);
rl.prompt();
