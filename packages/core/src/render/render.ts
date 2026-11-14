/**
 * Turns the conversation the frontend sends into messages for the model.
 *
 * Rendering is deterministic: the same item always becomes the same text, and nothing already
 * sent to the model is changed later. That keeps prompt caches warm and replayed thinking blocks
 * valid. The scaffolding is English; names and texts stay as they appear on screen.
 */
import type { Effect, GuideResult, Locator, Perception, Screen, ScreenNode, TimelineEntry, TurnRequest } from '@doccue/protocol';
import type { Message } from '../model/types.js';
import { isLocale } from '../protocol/parse.js';

export const DEFAULT_INSTRUCTIONS =
  'You are the in-app assistant of this product. You help users get started and solve problems they run into while using it.';

const CONTEXT_GUIDE = `Each user message starts with a <context> block written by the app, not by the user. It lists what the user did recently and what each action caused (latest last), followed by a tree of the screen the user is looking at. A number in brackets, like [3], identifies an element of that screen.
Use the context to work out what the user is trying to do and what went wrong. Refer to controls by the names shown on screen, and only to controls that are there. Never mention the context block or the numbers to the user.
Answer in the user's language (the locale given in the first context block, unless they write in another language), briefly and concretely.`;

const GUIDE_GUIDE = `You cannot operate the app; the user does. When the answer involves something on the user's screen (where to click, which field to fix, how to get somewhere), show it with the guide tool instead of only describing it: say in one sentence what the problem or the plan is, then call guide. Put the instructions into the steps, not into your reply. The user's question sets the goal. When a guide comes back, check in the result whether that goal is reached: if it is, say so in a sentence and stop, even if other things on the page are unfinished or look wrong. If it is not reached and the next steps are on the screen, keep going with another guide call: never hand the rest of the task back as a list of instructions in words. A step the user skipped was their choice: don't guide them through it again, mention it in words if it matters. For questions that need no pointing, just answer.`;

/** Recent actions shown per context block. */
const MAX_ACTIONS = 20;

/** The developer's instructions, how to read the context and when to guide, then any `extra` parts (e.g. the docs). */
export function buildSystemPrompt(instructions: string = DEFAULT_INSTRUCTIONS, extra: readonly string[] = []): string {
  return [instructions.trim(), CONTEXT_GUIDE, GUIDE_GUIDE, ...extra].join('\n\n');
}

const quote = (text: string) => JSON.stringify(text);

/**
 * Breaks up anything in the text that reads as a context tag, so that text from the page (a name
 * on screen, a value typed into a field) or the question can't close the block or open a new one.
 */
const unfence = (text: string) => text.replace(/<(\/?context)/gi, '‹$1');

/** `button "删除" in row "mysql-prod" in dialog "确认"`. */
export function renderLocator(locator: Locator): string {
  const parts = [locator.name ? `${locator.role} ${quote(locator.name)}` : locator.role];
  for (const region of [...(locator.within ?? [])].reverse()) parts.push(`${region.kind} ${quote(region.name)}`);
  return parts.join(' in ');
}

function renderEffect(effect: Effect): string {
  switch (effect.type) {
    case 'error':
      return `error ${quote(effect.text)}${effect.target ? ` on ${renderLocator(effect.target)}` : ''}`;
    case 'notice':
      return `notice ${quote(effect.text)}`;
    case 'dialog':
      return `dialog ${quote(effect.name)} ${effect.state}`;
    case 'navigate':
      return `went to page ${effect.page.title ? `${quote(effect.page.title)} ` : ''}${effect.page.path}`;
    case 'request_failed':
      return `request ${effect.method} ${effect.path} failed${effect.status === undefined ? '' : ` with ${effect.status}`}${effect.message ? `: ${effect.message}` : ''}`;
    case 'script_error':
      return `script error: ${effect.message}`;
  }
}

/** One timeline entry without its time, e.g. `click button "测试连接" -> error "Invalid Host Format"`. */
function renderEntry(entry: TimelineEntry): string {
  const effects = (entry.effects ?? []).map(renderEffect).join('; ');
  if (!entry.action) return effects;
  const { type, target, value } = entry.action;
  let line = target ? `${type} ${renderLocator(target)}` : type;
  if (value !== undefined) line += ` = ${quote(value)}`;
  return effects ? `${line} -> ${effects}` : line;
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** The latest actions, one per line; identical consecutive ones are folded into one with a count. */
export function renderActions(actions: readonly TimelineEntry[], now: number): string[] {
  const folded: Array<{ text: string; at: number; count: number }> = [];
  for (const entry of actions) {
    const text = renderEntry(entry);
    const last = folded[folded.length - 1];
    if (last && last.text === text) {
      last.at = entry.at;
      last.count++;
    } else {
      folded.push({ text, at: entry.at, count: 1 });
    }
  }
  return folded.slice(-MAX_ACTIONS).map(({ text, at, count }) => `${age(now - at)}: ${text}${count > 1 ? ` (x${count})` : ''}`);
}

function renderNode(node: ScreenNode, depth: number, lines: string[]): void {
  let line = `${'  '.repeat(depth)}${node.ref === undefined ? '' : `[${node.ref}] `}${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  if (node.value !== undefined) line += ` = ${quote(node.value)}`;
  if (node.states && node.states.length > 0) line += ` (${node.states.join(', ')})`;
  lines.push(line);
  for (const child of node.children ?? []) renderNode(child, depth + 1, lines);
  if (node.more) lines.push(`${'  '.repeat(depth + 1)}... ${node.more} more not shown`);
}

/** The screen tree as indented lines, e.g. `  [3] textbox "主机地址" = "127.0.0.1" (invalid)`. */
export function renderScreen(screen: Screen): string {
  const lines = [`page ${screen.page.title ? `${quote(screen.page.title)} ` : ''}${screen.page.path}`];
  for (const node of screen.nodes) renderNode(node, 0, lines);
  if (screen.truncated) lines.push(`... ${screen.truncated} more elements not shown`);
  return lines.join('\n');
}

function renderPerception(perception: Perception): string[] {
  const lines: string[] = [];
  const actions = renderActions(perception.actions, perception.at);
  if (actions.length > 0) lines.push('recent actions:', ...actions);
  lines.push('screen:', renderScreen(perception.screen));
  return lines;
}

function renderUser(user: Record<string, unknown>): string {
  return Object.entries(user)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

/** What a guide did, as the result of the `guide` tool call. */
function renderGuideResult(result: GuideResult): string {
  const lines = [`outcome: ${result.outcome}`, `completed steps: ${result.completedSteps}`];
  if (result.skippedSteps && result.skippedSteps.length > 0) lines.push(`skipped by the user (pressed Next without doing them): step ${result.skippedSteps.join(', ')}`);
  return [...lines, ...renderPerception(result.perception)].join('\n');
}

export type RenderInput = Pick<TurnRequest, 'conversation' | 'locale' | 'user'>;

/** The whole conversation as model messages. The locale and user details go into the first context block. */
export function renderConversation({ conversation, locale, user }: RenderInput): Message[] {
  const messages: Message[] = [];
  let first = true;
  for (const item of conversation) {
    if (item.type === 'user') {
      const lines: string[] = [];
      if (first && user && Object.keys(user).length > 0) lines.push(`user: ${renderUser(user)}`);
      lines.push(...renderPerception(item.perception));
      const open = first && isLocale(locale) ? `<context locale="${locale}">` : '<context>';
      messages.push({ role: 'user', content: [open, unfence(lines.join('\n')), '</context>', unfence(item.text)].join('\n') });
      first = false;
    } else if (item.type === 'model') {
      messages.push(...(item.messages as Message[]));
    } else {
      const result = { callId: item.callId, content: unfence(renderGuideResult(item.result)) };
      // Backend tools called in the same step already left their results: one message for all.
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') messages[messages.length - 1] = { role: 'tool', results: [...last.results, result] };
      else messages.push({ role: 'tool', results: [result] });
    }
  }
  return messages;
}

/** The text of the last user message: what the model saw with the latest question. */
export function renderLastUserMessage(input: RenderInput): string | undefined {
  const messages = renderConversation(input);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') return message.content;
  }
  return undefined;
}
