/**
 * The context layer: what the model sees each turn.
 *
 * - A fixed system prompt (the developer's instructions plus a short guide to the status bar),
 *   kept identical for the whole conversation so it stays cached.
 * - The session history, unchanged.
 * - A status bar, appended as a user message before a model call whenever the state changed
 *   since the last one. Earlier status bars stay where they are: editing history would break the
 *   prompt cache and, on current Claude models, invalidate earlier thinking blocks. The latest
 *   one is current.
 * - The screen tree, appended when it changed and capped in size. Until the `get_screen` tool
 *   exists this is the only way the model sees the page.
 */
import type { Message, TextPart } from '../model/types.js';
import type { SessionState } from '../state/types.js';
import { formatClock, renderStatus, type RenderOptions } from './render.js';
import type { ContextBuilder, TurnRequest } from './types.js';

export interface StatusContextOptions extends RenderOptions {
  /** The product-specific part of the system prompt: what the app is, tone, rules. */
  instructions?: string;
  /** Screen tree: sent when it changed, cut at `maxChars` (default 2000). `false` never sends it. */
  screen?: false | { maxChars?: number };
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_INSTRUCTIONS =
  "You are the in-app assistant of this product. You help users get started and solve problems they run into while using it. Answer in the user's language, briefly and concretely.";

const STATUS_GUIDE =
  "Some user messages include a <status> block written by the app, not by the user. It shows what the app knew at that moment: the current page, onboarding progress, visible errors, user details, and the user's recent actions with what each one caused. The most recent <status> is current; earlier ones are history. A <screen> block, when present, is a compact tree of the page the user is on. Use them to work out what the user is doing and what went wrong. Refer to controls by the names shown there, and don't mention these blocks to the user.";

const STATUS_TAG = '<status';
const SCREEN_TAG = '<screen>';

export function buildSystemPrompt(instructions: string = DEFAULT_INSTRUCTIONS): string {
  return `${instructions.trim()}\n\n${STATUS_GUIDE}`;
}

export function statusContext(options: StatusContextOptions = {}): ContextBuilder {
  const system = buildSystemPrompt(options.instructions);
  const now = options.now ?? Date.now;
  const screenMax = options.screen === false ? 0 : (options.screen?.maxChars ?? 2000);

  return {
    prepare({ session, request, getSession }) {
      // A turn the user didn't ask for always starts with a status that says why.
      let note = request.reason === 'user_message' ? undefined : triggerNote(request);
      return {
        system,
        messages: session.history,
        beforeModelCall: async ({ transcript }) => {
          const message = statusMessage(await getSession(), transcript, { ...options, screenMax, now: now(), note });
          note = undefined;
          return message ? [message] : [];
        },
      };
    },
  };
}

function triggerNote(request: TurnRequest): string {
  return `（用户没有提问，这一轮由应用发起：${request.note ?? request.reason}）`;
}

interface StatusMessageOptions extends RenderOptions {
  screenMax: number;
  now: number;
  note: string | undefined;
}

/** The status (and screen) message to append, or `undefined` if nothing changed since the last one. */
export function statusMessage(
  session: SessionState,
  transcript: readonly Message[],
  options: StatusMessageOptions,
): Message | undefined {
  const parts: TextPart[] = [];

  const body = renderStatus(session, options);
  // The note sits outside the status block so it doesn't count as a status change later.
  if (options.note) parts.push({ type: 'text', text: options.note });
  if (body && (options.note || body !== statusBody(lastText(transcript, STATUS_TAG)))) {
    parts.push({ type: 'text', text: `<status time="${formatClock(options.now, options.timeZone)}">\n${body}\n</status>` });
  }

  const screen = session.perception.screen?.text;
  if (options.screenMax > 0 && screen) {
    const shown = screen.length > options.screenMax ? `${screen.slice(0, options.screenMax)}\n…（已截断）` : screen;
    const block = `${SCREEN_TAG}\n${shown}\n</screen>`;
    if (block !== lastText(transcript, SCREEN_TAG)) parts.push({ type: 'text', text: block });
  }

  return parts.length > 0 ? { role: 'user', content: parts } : undefined;
}

/** The status body without its opening and closing tag lines. */
function statusBody(block: string | undefined): string | undefined {
  return block?.split('\n').slice(1, -1).join('\n');
}

/** The most recent user text in the transcript that starts with `prefix`. */
function lastText(transcript: readonly Message[], prefix: string): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message?.role !== 'user') continue;
    const texts = typeof message.content === 'string' ? [message.content] : message.content.map((part) => (part.type === 'text' ? part.text : ''));
    for (let j = texts.length - 1; j >= 0; j--) {
      const text = texts[j];
      if (text?.startsWith(prefix)) return text;
    }
  }
  return undefined;
}
