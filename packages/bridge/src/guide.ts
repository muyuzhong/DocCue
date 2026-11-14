/**
 * Runs one guide: a spotlight on the current step's element and a bubble with its text. A step
 * is done when the user acts on the element or presses Next; then the next step is shown.
 *
 * The overlay never blocks the page: the user can click anywhere. If the element of the current
 * step is not there (yet, or any more), the guide waits a moment and then gives up.
 */
import type { GuideResult, GuideStep } from '@doccue/protocol';
import type { Messages } from './messages.js';

export type GuideEnd = Pick<GuideResult, 'outcome' | 'completedSteps' | 'skippedSteps'>;

export interface GuideOptions {
  document: Document;
  steps: readonly GuideStep[];
  /** The element of a step right now, or `undefined` while it is not on the page. */
  find: (index: number) => Element | undefined;
  messages: Messages;
  /** How long to wait for a step's element before giving up. */
  waitMs: number;
  /** Where to start, when a guide continues after a page reload. */
  start?: Omit<GuideEnd, 'outcome'>;
  /** Called whenever the guide moves on, so its progress can be saved. */
  onProgress?: (progress: Omit<GuideEnd, 'outcome'>) => void;
}

export interface RunningGuide {
  /** Resolves when the guide ends by itself; with `undefined` when it was stopped from outside. */
  done: Promise<GuideEnd | undefined>;
  /** Tell the guide the user acted on this element. */
  action(element: Element): void;
  /** Removes the guide. Returns how far it got. */
  stop(): Omit<GuideEnd, 'outcome'>;
}

// One below the chat panel, so its bar stays clear of the dimming.
const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font: 14px/1.5 system-ui, sans-serif; }
.spot { position: fixed; border-radius: 6px; box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.45), 0 0 0 2px #4f8cff; transition: all 0.15s ease-out; }
.bubble { position: fixed; pointer-events: auto; box-sizing: border-box; width: max-content; max-width: 320px; padding: 12px 14px; border-radius: 10px; background: #fff; color: #111827; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.28); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.progress { flex: 1; color: #6b7280; font-size: 12px; }
button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #111827; cursor: pointer; }
button.next { border-color: #2563eb; background: #2563eb; color: #fff; }
[hidden] { display: none; }
`;

const GAP = 10;
const PAD = 4;

export function runGuide(options: GuideOptions): RunningGuide {
  const { document, steps, messages } = options;
  const view = document.defaultView!;

  // Everything lives in a shadow root so the page's styles don't reach it; `data-cue-ignore`
  // keeps the recorder and the screen snapshot out.
  const host = document.createElement('div');
  host.setAttribute('data-cue-ignore', '');
  host.setAttribute('data-doccue-guide', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <div class="layer" data-cue-ignore>
      <div class="spot" hidden></div>
      <div class="bubble" role="dialog" hidden>
        <div class="text"></div>
        <div class="foot"><span class="progress"></span><button type="button" class="exit"></button><button type="button" class="next"></button></div>
      </div>
    </div>`;
  const spot = root.querySelector<HTMLElement>('.spot')!;
  const bubble = root.querySelector<HTMLElement>('.bubble')!;
  const text = root.querySelector<HTMLElement>('.text')!;
  const progress = root.querySelector<HTMLElement>('.progress')!;
  const next = root.querySelector<HTMLButtonElement>('.next')!;
  const exit = root.querySelector<HTMLButtonElement>('.exit')!;
  exit.textContent = messages.exit;
  document.body.append(host);

  let index = options.start?.completedSteps ?? 0;
  /** Steps (counted from 1) passed without the user acting on their element. */
  const skipped: number[] = [...(options.start?.skippedSteps ?? [])];
  const reached = (): Omit<GuideEnd, 'outcome'> => ({ completedSteps: index, ...(skipped.length > 0 ? { skippedSteps: [...skipped] } : {}) });
  /** Whether the current step's element has been shown at least once. */
  let shown = false;
  let missingSince: number | undefined;
  let current: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let resolve: (end: GuideEnd | undefined) => void = () => {};
  const done = new Promise<GuideEnd | undefined>((r) => (resolve = r));

  // Between ticks, follow the element when the page scrolls or the window is resized.
  const follow = () => {
    if (current && !bubble.hidden) place(current);
  };
  view.addEventListener('scroll', follow, true);
  view.addEventListener('resize', follow);

  const finish = (end: GuideEnd | undefined) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    view.removeEventListener('scroll', follow, true);
    view.removeEventListener('resize', follow);
    host.remove();
    resolve(end);
  };

  const advance = () => {
    index++;
    shown = false;
    missingSince = undefined;
    current = undefined;
    options.onProgress?.(reached());
    if (index >= steps.length) finish({ outcome: 'completed', ...reached() });
    else tick();
  };

  function place(target: Element): void {
    const rect = target.getBoundingClientRect();
    spot.style.left = `${rect.left - PAD}px`;
    spot.style.top = `${rect.top - PAD}px`;
    spot.style.width = `${rect.width + PAD * 2}px`;
    spot.style.height = `${rect.height + PAD * 2}px`;
    const size = bubble.getBoundingClientRect();
    const below = rect.bottom + GAP;
    const top = below + size.height > view.innerHeight ? Math.max(8, rect.top - size.height - GAP) : below;
    const left = Math.max(8, Math.min(rect.left, view.innerWidth - size.width - 8));
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
  }

  /** Shows the current step if its element is there, and keeps the overlay on it. */
  function tick(): void {
    if (ended) return;
    clearTimeout(timer);
    current = options.find(index);
    if (current) {
      missingSince = undefined;
      if (!shown) {
        shown = true;
        const rect = current.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > view.innerHeight) current.scrollIntoView?.({ block: 'center' });
        text.textContent = steps[index]!.text;
        progress.textContent = steps.length > 1 ? `${index + 1} / ${steps.length}` : '';
        next.textContent = index === steps.length - 1 ? messages.done : messages.next;
      }
      spot.hidden = false;
      bubble.hidden = false;
      place(current);
    } else {
      spot.hidden = true;
      bubble.hidden = true;
      missingSince ??= Date.now();
      if (Date.now() - missingSince > options.waitMs) {
        // It was there and went away: the user went somewhere else. It never showed: we can't find it.
        finish({ outcome: shown ? 'deviated' : 'not_found', ...reached() });
        return;
      }
    }
    timer = setTimeout(tick, 100);
  }

  next.addEventListener('click', () => {
    if (steps[index]!.expect !== 'ack') skipped.push(index + 1);
    advance();
  });
  exit.addEventListener('click', () => finish({ outcome: 'exited', ...reached() }));
  tick();

  return {
    done,
    action(element) {
      if (ended) return;
      // The current step, or a later one the user got to first: the steps in between count as skipped.
      for (let at = index; at < steps.length; at++) {
        if (steps[at]!.expect === 'ack') continue;
        const target = at === index ? current : options.find(at);
        if (!target || (target !== element && !target.contains(element))) continue;
        for (let passed = index; passed < at; passed++) if (steps[passed]!.expect !== 'ack') skipped.push(passed + 1);
        index = at;
        advance();
        return;
      }
    },
    stop() {
      finish(undefined);
      return reached();
    },
  };
}
