/**
 * The built-in chat panel: a round button in a corner of the page that opens a small chat. It
 * shows the answers as they stream, what the agent is doing (thinking, checking the docs), and
 * folds into a slim bar while a guide is on the page so it doesn't cover what the guide points at.
 *
 * It lives in a shadow root, so the page's styles don't reach it, and inside `data-cue-ignore`,
 * so the bridge never records typing in it. What it shows is kept per tab (sessionStorage), so a
 * page load doesn't lose the conversation on screen. Answers are rendered from a small, escaped
 * subset of Markdown: nothing in an answer can become markup.
 *
 * Position and colour come from CSS variables the page can set: `--doccue-right` (or
 * `--doccue-left`), `--doccue-bottom`, `--doccue-accent`, `--doccue-z`.
 */
import type { Bridge, BridgeEvent } from '../bridge.js';
import { THEME_COLOURS } from '../guide.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

export interface PanelOptions {
  /** Open the panel right away on the first page; after that, the user's choice is kept for the tab. */
  open?: boolean;
  /** Which bottom corner. Defaults to `right`. */
  side?: 'left' | 'right';
  document?: Document;
}

export interface Panel {
  open(): void;
  close(): void;
  /** Takes the panel off the page. The conversation stays. */
  unmount(): void;
}

/** One line of the conversation as shown. */
interface Line {
  role: 'user' | 'assistant' | 'note' | 'error';
  text: string;
}

const LINES_KEY = 'doccue:panel:lines';
/** Lines kept and shown; older ones go, and the panel says so. */
const MAX_LINES = 200;
const OPEN_KEY = 'doccue:panel:open';

const DOC_TOOLS = new Set(['search_docs', 'read_doc']);

const ICON_CHAT =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.6 3.4 6.1L4.6 21l4.3-2.3c1 .3 2 .4 3.1.4 5.5 0 10-3.6 10-8.1S17.5 3 12 3Z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_NEW =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4"/></svg>';

const STYLE = `
:host { all: initial; position: fixed; bottom: var(--doccue-bottom, 20px); right: var(--doccue-right, 20px); z-index: var(--doccue-z, 2147483647); }
:host([data-side="left"]) { right: auto; left: var(--doccue-left, 20px); }
${THEME_COLOURS}
.root { font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--fg); }
[hidden] { display: none !important; }
button { font: inherit; cursor: pointer; }
.launcher { width: 54px; height: 54px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; display: grid; place-items: center; box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25); }
.launcher:hover { filter: brightness(1.08); }
.panel { box-sizing: border-box; width: min(380px, calc(100vw - 24px)); height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column; background: var(--bg); border-radius: 14px; box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25); overflow: hidden; }
header { display: flex; align-items: center; gap: 4px; padding: 12px 10px 12px 16px; border-bottom: 1px solid var(--line); }
header strong { flex: 1; font-size: 15px; }
.icon { border: 0; background: none; color: var(--muted); width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; }
.icon:hover { background: var(--soft); color: var(--fg); }
.messages { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 10px; }
.greeting, .earlier { color: var(--muted); font-size: 13px; padding: 4px 2px; }
.earlier { align-self: center; font-size: 12px; }
.message { max-width: 88%; padding: 8px 12px; border-radius: 12px; overflow-wrap: anywhere; }
.message.user { align-self: flex-end; background: var(--accent); color: #fff; white-space: pre-wrap; }
.message.assistant { align-self: flex-start; background: var(--soft); }
.message.note, .message.error { align-self: center; padding: 0; background: none; font-size: 12px; color: var(--muted); }
.message.error { color: #dc2626; }
.message p { margin: 0 0 6px; } .message p:last-child { margin-bottom: 0; }
.message ul, .message ol { margin: 4px 0; padding-left: 20px; }
.message code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(127, 127, 127, 0.15); padding: 1px 4px; border-radius: 4px; }
.message pre { margin: 6px 0; padding: 8px; background: rgba(127, 127, 127, 0.15); border-radius: 6px; overflow-x: auto; }
.message pre code { background: none; padding: 0; }
.message a { color: var(--accent); }
.message .site { color: var(--muted); font-size: 12px; }
.status { color: var(--muted); font-size: 13px; }
.message .status { display: block; margin-top: 4px; }
.composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px 12px; border-top: 1px solid var(--line); }
textarea { flex: 1; box-sizing: border-box; resize: none; min-height: 40px; max-height: 120px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); font: inherit; color: inherit; outline: none; }
textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.send, .stop { height: 40px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.stop { background: var(--button); color: var(--fg); border-color: var(--line); }
.send:disabled { opacity: 0.45; cursor: default; }
.bar { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; background: var(--bg); border-radius: 999px; box-shadow: 0 6px 20px rgba(15, 23, 42, 0.22); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.bar button { border: 1px solid var(--line); background: var(--button); border-radius: 999px; padding: 4px 12px; font-size: 13px; color: var(--fg); }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
/* Phones: the open panel takes the whole screen. */
@media (max-width: 480px) {
  .panel { position: fixed; inset: 0; width: 100vw; height: 100dvh; border-radius: 0; }
}
`;

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function mountPanel(bridge: Bridge, options: PanelOptions = {}): Panel {
  const document = options.document ?? globalThis.document;
  const storage = store();
  const t = bridge.messages;

  const load = <T>(key: string, fallback: T): T => {
    try {
      const raw = storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key: string, value: unknown) => {
    try {
      storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Full or blocked: keep it in memory only.
    }
  };

  // What was said, as shown. A conversation the bridge no longer has (reset elsewhere) is dropped.
  let lines = bridge.conversation().length > 0 ? load<Line[]>(LINES_KEY, []) : [];
  let wantOpen = load<boolean | undefined>(OPEN_KEY, undefined) ?? options.open ?? false;
  /** The user opened the panel although a guide is on the page. */
  let expanded = false;
  /** The answer streaming in right now. */
  let pending: { element: HTMLElement; text: string } | undefined;
  /** The user pressed Stop: say so once the bridge is idle. */
  let stopped = false;

  const host = document.createElement('div');
  host.setAttribute('data-doccue-panel', '');
  host.setAttribute('data-cue-ignore', '');
  if (options.side === 'left') host.setAttribute('data-side', 'left');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <div class="root themed" data-theme="${bridge.theme}" data-cue-ignore>
      <button type="button" class="launcher" aria-label="${escapeHtml(t.open)}" title="${escapeHtml(t.open)}">${ICON_CHAT}</button>
      <section class="panel" role="dialog" aria-label="${escapeHtml(t.title)}" hidden>
        <header>
          <strong>${escapeHtml(t.title)}</strong>
          <button type="button" class="icon reset" aria-label="${escapeHtml(t.newConversation)}" title="${escapeHtml(t.newConversation)}">${ICON_NEW}</button>
          <button type="button" class="icon close" aria-label="${escapeHtml(t.close)}" title="${escapeHtml(t.close)}">${ICON_CLOSE}</button>
        </header>
        <div class="messages" aria-live="polite"></div>
        <form class="composer">
          <textarea rows="1" maxlength="${bridge.maxQuestionChars}" placeholder="${escapeHtml(t.placeholder)}" aria-label="${escapeHtml(t.placeholder)}"></textarea>
          <button type="button" class="stop" hidden>${escapeHtml(t.stop)}</button>
          <button type="submit" class="send" disabled>${escapeHtml(t.send)}</button>
        </form>
      </section>
      <div class="bar" role="status" hidden>
        <span class="dot"></span><span>${escapeHtml(t.guiding)}</span>
        <button type="button" class="expand">${escapeHtml(t.expand)}</button>
        <button type="button" class="bar-stop">${escapeHtml(t.stop)}</button>
      </div>
    </div>`;
  const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const launcher = $<HTMLButtonElement>('.launcher');
  const panel = $<HTMLElement>('.panel');
  const bar = $<HTMLElement>('.bar');
  const list = $<HTMLElement>('.messages');
  const textarea = $<HTMLTextAreaElement>('textarea');
  const send = $<HTMLButtonElement>('.send');
  const stop = $<HTMLButtonElement>('.stop');

  /** Shows the launcher, the panel or the bar, whichever fits the moment. */
  const layout = () => {
    const folded = bridge.guiding() && !expanded;
    bar.hidden = !folded;
    panel.hidden = folded || !wantOpen;
    launcher.hidden = folded || wantOpen;
    stop.hidden = !bridge.busy();
  };

  const scroll = () => {
    list.scrollTop = list.scrollHeight;
  };

  const lineElement = (line: Line) => {
    const element = document.createElement('div');
    element.className = `message ${line.role}`;
    if (line.role === 'assistant') element.innerHTML = renderMarkdown(line.text);
    else element.textContent = line.text;
    return element;
  };

  /** Whether older lines were dropped. */
  let dropped = load<boolean>(`${LINES_KEY}:dropped`, false) && lines.length > 0;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(-MAX_LINES);
    dropped = true;
  }

  const earlierNote = () => {
    const note = document.createElement('div');
    note.className = 'earlier';
    note.textContent = t.earlier;
    return note;
  };

  const drawAll = () => {
    list.replaceChildren();
    if (dropped) list.append(earlierNote());
    if (lines.length === 0) {
      const greeting = document.createElement('div');
      greeting.className = 'greeting';
      greeting.textContent = t.greeting;
      list.append(greeting);
    }
    for (const line of lines) list.append(lineElement(line));
    scroll();
  };

  const add = (line: Line) => {
    if (lines.length === 0) list.replaceChildren();
    lines = [...lines, line];
    if (lines.length > MAX_LINES) {
      lines = lines.slice(-MAX_LINES);
      dropped = true;
      save(`${LINES_KEY}:dropped`, true);
      // Drop the oldest line on screen too (after the note, if it is there).
      const oldest = list.querySelector('.message');
      oldest?.remove();
      if (!list.querySelector('.earlier')) list.prepend(earlierNote());
    }
    save(LINES_KEY, lines);
    list.append(lineElement(line));
    scroll();
  };

  /** The bubble of the answer streaming in, created on its first sign of life. */
  const bubble = () => {
    if (!pending) {
      if (lines.length === 0) list.replaceChildren();
      const element = document.createElement('div');
      element.className = 'message assistant';
      list.append(element);
      pending = { element, text: '' };
    }
    return pending;
  };

  const showStatus = (text: string) => {
    const current = bubble();
    current.element.innerHTML = `${renderMarkdown(current.text)}<span class="status">${escapeHtml(text)}</span>`;
    scroll();
  };

  /** The answer of one request is over: keep its text as a line of its own. */
  const settle = () => {
    if (!pending) return;
    const { element, text } = pending;
    pending = undefined;
    element.remove();
    if (text.trim()) add({ role: 'assistant', text });
  };

  const showFailure = (failure: { status?: number }) => {
    settle();
    add({ role: 'error', text: failure.status === 400 || failure.status === 413 ? t.failedConversation : t.failed });
  };

  /** A tool ran since the last text: what the model writes next is a new paragraph. */
  let newPart = false;
  const handlers: { [K in BridgeEvent['type']]?: (event: Extract<BridgeEvent, { type: K }>) => void } = {
    status: (event) => {
      if (event.state === 'tool') newPart = true;
      showStatus(event.state === 'tool' ? (DOC_TOOLS.has(event.tool ?? '') ? t.readingDocs : t.working) : t.thinking);
    },
    text: (event) => {
      const current = bubble();
      current.text = appendText(current.text, event.delta, newPart);
      newPart = false;
      current.element.innerHTML = renderMarkdown(current.text);
      scroll();
    },
    end: (event) => {
      settle();
      if (event.reason === 'max_tokens') add({ role: 'note', text: t.cutOff });
      else if (event.reason === 'refusal') add({ role: 'note', text: t.refused });
      else if (event.reason === 'error' || event.reason === 'timeout' || event.reason === 'max_steps') add({ role: 'error', text: t.failed });
    },
    error: (event) => showFailure(event),
    guide_start: () => {
      expanded = false;
      layout();
    },
    guide_end: () => layout(),
    state: (event) => {
      if (!event.busy) {
        settle();
        if (stopped) add({ role: 'note', text: t.stopped });
        stopped = false;
      }
      layout();
    },
    reset: () => {
      pending = undefined;
      lines = [];
      dropped = false;
      save(LINES_KEY, lines);
      save(`${LINES_KEY}:dropped`, false);
      drawAll();
      layout();
    },
  };
  const offs = Object.entries(handlers).map(([type, handler]) => bridge.on(type as BridgeEvent['type'], handler as never));

  const setOpen = (open: boolean) => {
    wantOpen = open;
    save(OPEN_KEY, open);
    layout();
    if (open) {
      scroll();
      textarea.focus();
    } else {
      launcher.focus();
    }
  };

  const submit = () => {
    const question = textarea.value.trim();
    if (!question) return;
    textarea.value = '';
    send.disabled = true;
    settle();
    add({ role: 'user', text: question });
    // Failures show through the bridge's `error` event; the details go to the console.
    void bridge.ask(question).catch((error: unknown) => console.warn('DocCue:', error));
    layout();
  };

  launcher.addEventListener('click', () => setOpen(true));
  $('.close').addEventListener('click', () => setOpen(false));
  $('.reset').addEventListener('click', () => bridge.reset());
  $('.expand').addEventListener('click', () => {
    expanded = true;
    setOpen(true);
  });
  const halt = () => {
    stopped = bridge.busy();
    bridge.stop();
  };
  stop.addEventListener('click', halt);
  $('.bar-stop').addEventListener('click', halt);
  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  textarea.addEventListener('input', () => {
    send.disabled = !textarea.value.trim();
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  document.body.append(host);
  drawAll();
  // A question that failed before the panel was here (a request resumed on page load, say).
  const failed = bridge.lastError();
  if (failed && !bridge.busy()) showFailure(failed);
  layout();

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    unmount() {
      for (const off of offs) off();
      host.remove();
    },
  };
}

/**
 * An answer's text with the next piece added. What the model writes after a tool call (it says
 * "let me check the docs", searches, then answers) starts a new paragraph instead of running on.
 */
export function appendText(text: string, delta: string, newPart: boolean): string {
  return newPart && text.trim() ? `${text.trimEnd()}\n\n${delta.trimStart()}` : text + delta;
}
