/**
 * Runs one guide: a spotlight on the current step's element and a bubble with its text. A step
 * is done when the user acts on the element or presses Next; then the next step is shown.
 *
 * The overlay never blocks the page: the user can click anywhere. If the element of the current
 * step is not there (yet, or any more), the guide waits a moment and then gives up.
 */
import type { GuideResult, GuideStep } from '@doccue/protocol';
import type { Messages } from './messages.js';
import { isIgnored, isVisible } from './dom.js';
import { CANDIDATE_SELECTOR, hasControlInside, isInteractive } from './naming.js';

export type GuideEnd = Pick<GuideResult, 'outcome' | 'completedSteps' | 'skippedSteps'>;

export interface GuideOptions {
  document: Document;
  steps: readonly GuideStep[];
  /** The element of a step right now, or `undefined` while it is not on the page. */
  find: (index: number) => Element | undefined;
  messages: Messages;
  /** Colours of the bubble. Defaults to `light`. */
  theme?: Theme;
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

/** Colours of the bridge's UI: light, dark, or following the system. */
export type Theme = 'light' | 'dark' | 'auto';

/** Colours of the bridge's UI, light and dark; shared with the chat panel. */
export const THEME_COLOURS = `
.themed { --bg: #fff; --fg: #111827; --muted: #6b7280; --line: #d1d5db; --soft: #f3f4f6; --button: #fff; --accent: var(--doccue-accent, #2563eb); color-scheme: light; }
.themed[data-theme="dark"] { --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --line: #4b5563; --soft: #374151; --button: #374151; color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  .themed[data-theme="auto"] { --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --line: #4b5563; --soft: #374151; --button: #374151; color-scheme: dark; }
}
`;

// One below the chat panel, so its bar stays clear of the dimming.
const STYLE = `
:host { all: initial; }
${THEME_COLOURS}
.layer { position: fixed; inset: 0; pointer-events: none; z-index: calc(var(--doccue-z, 2147483647) - 1); font: 14px/1.5 system-ui, sans-serif; }
.spot { position: fixed; border-radius: 6px; box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.45), 0 0 0 2px var(--doccue-accent, #4f8cff); transition: all 0.15s ease-out; }
.bubble { position: fixed; pointer-events: auto; box-sizing: border-box; width: max-content; max-width: 320px; padding: 12px 14px; border-radius: 10px; background: var(--bg); color: var(--fg); box-shadow: 0 8px 28px rgba(15, 23, 42, 0.28); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.progress { flex: 1; color: var(--muted); font-size: 12px; }
button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--button); color: var(--fg); cursor: pointer; }
button.next { border-color: var(--accent); background: var(--accent); color: #fff; }
[hidden] { display: none; }
`;

const GAP = 10;
const PAD = 4;

export type Side = 'below' | 'right' | 'above' | 'left';
/** In this order when nothing else decides. */
const SIDES: Side[] = ['below', 'right', 'above', 'left'];
const MARGIN = 8;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Where the bubble goes on one side of the target, and whether it fits on screen there. */
function position(rect: DOMRect, size: { width: number; height: number }, side: Side, screen: { width: number; height: number }): { top: number; left: number; fits: boolean } {
  const across = clamp(rect.left, MARGIN, screen.width - size.width - MARGIN);
  const along = clamp(rect.top + rect.height / 2 - size.height / 2, MARGIN, screen.height - size.height - MARGIN);
  switch (side) {
    case 'below': {
      const top = rect.bottom + GAP;
      return { top, left: across, fits: top + size.height <= screen.height - MARGIN };
    }
    case 'above': {
      const top = rect.top - GAP - size.height;
      return { top, left: across, fits: top >= MARGIN };
    }
    case 'right': {
      const left = rect.right + GAP;
      return { top: along, left, fits: left + size.width <= screen.width - MARGIN };
    }
    case 'left': {
      const left = rect.left - GAP - size.width;
      return { top: along, left, fits: left >= MARGIN };
    }
  }
}

/**
 * Where the bubble goes: on its side of the target, kept on screen. A target taller or wider than
 * the window leaves no side where the bubble fits; it then covers part of the target rather than
 * sitting off screen, where its buttons can't be reached.
 */
export function bubbleAt(rect: DOMRect, size: { width: number; height: number }, side: Side, screen: { width: number; height: number }): { top: number; left: number; fits: boolean } {
  const at = position(rect, size, side, screen);
  return {
    top: clamp(at.top, MARGIN, Math.max(MARGIN, screen.height - size.height - MARGIN)),
    left: clamp(at.left, MARGIN, Math.max(MARGIN, screen.width - size.width - MARGIN)),
    fits: at.fits,
  };
}

function overlap(a: Box, b: DOMRect): number {
  const width = Math.min(a.left + a.width, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * What the user sees of an element. Pages often hide a native checkbox or radio (transparent, or
 * a sliver wide) and draw their own in its label: the spotlight goes on the label then. Only where
 * the spotlight goes changes; the step still waits for the control itself.
 */
export function faceOf(element: Element): Element {
  if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return element;
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  // Without layout (a test DOM) every box is 0 by 0: that alone says nothing.
  const sliver = rect.width + rect.height > 0 && (rect.width < 4 || rect.height < 4);
  const transparent = view?.getComputedStyle(element).opacity === '0';
  if (!sliver && !transparent) return element;
  const label = (element as HTMLInputElement).labels?.[0] ?? element.closest('label');
  return label && isVisible(label) ? label : element;
}

/**
 * What an expanded control has opened and shows: the list, menu or dialog it names in
 * `aria-controls` or `aria-owns`, else the one list or menu showing on the page. The user picks
 * from it next, so the spotlight takes it in and the bubble keeps off it.
 */
export function popupOf(element: Element): Element | undefined {
  const control = element.getAttribute('aria-expanded') === 'true' ? element : element.querySelector('[aria-expanded="true"]');
  if (!control) return undefined;
  const document = element.ownerDocument;
  const usable = (popup: Element | null): popup is Element => !!popup && !popup.contains(element) && !isIgnored(popup) && isVisible(popup);
  const ids = `${control.getAttribute('aria-controls') ?? ''} ${control.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const popup = document.getElementById(id);
    if (usable(popup)) return popup;
  }
  const shown = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(usable);
  return shown.length === 1 ? shown[0] : undefined;
}

/** The smallest box around both. */
function union(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) };
}

/** Where DocCue's own chat panel is: the bubble must not go under it, or its buttons can't be clicked. */
function panelArea(document: Document): DOMRect | undefined {
  const panel = document.querySelector('[data-doccue-panel]');
  const rect = panel?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
}

/** The chat panel's area as a string, to notice when it opens, folds or closes. */
function panelKey(document: Document): string {
  const panel = panelArea(document);
  return panel ? `${panel.left},${panel.top},${panel.width},${panel.height}` : '';
}

/** The side where the bubble fits on screen, stays clear of the chat panel, and covers the least of the page's other controls. */
function chooseSide(target: Element, rect: DOMRect, size: { width: number; height: number }, screen: { width: number; height: number }): Side {
  const document = target.ownerDocument;
  const others = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR))
    .filter((element) => element !== target && !element.contains(target) && !target.contains(element) && isInteractive(element) && !isIgnored(element) && isVisible(element))
    .map((element) => element.getBoundingClientRect());
  const panel = panelArea(document);
  let best: { side: Side; covered: number } | undefined;
  for (const side of SIDES) {
    const at = position(rect, size, side, screen);
    if (!at.fits) continue;
    const box = { top: at.top, left: at.left, width: size.width, height: size.height };
    // Going under the panel is far worse than covering some of the page.
    const covered = others.reduce((sum, other) => sum + overlap(box, other), 0) + (panel ? overlap(box, panel) * 1000 : 0);
    if (!best || covered < best.covered) best = { side, covered };
  }
  return best?.side ?? 'below';
}

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
    <div class="layer themed" data-theme="${options.theme ?? 'light'}" data-cue-ignore>
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
  const follow = (event?: Event) => {
    if (event?.type === 'resize') side = undefined;
    if (current && !bubble.hidden) place(current);
  };
  view.addEventListener('scroll', follow, true);
  view.addEventListener('resize', follow);
  // A step on something that is no control and holds none (a heading, a card, a chart): the
  // recorder never sees a click there, so a click on it is what completes the step.
  const clickedOn = (event: Event) => {
    if (ended || !current) return;
    if (isInteractive(current) || hasControlInside(current) || !event.composedPath().includes(current)) return;
    advance();
  };
  document.addEventListener('click', clickedOn, true);

  const finish = (end: GuideEnd | undefined) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    view.removeEventListener('scroll', follow, true);
    view.removeEventListener('resize', follow);
    document.removeEventListener('click', clickedOn, true);
    host.remove();
    resolve(end);
  };

  const advance = () => {
    side = undefined;
    index++;
    shown = false;
    missingSince = undefined;
    current = undefined;
    options.onProgress?.(reached());
    if (index >= steps.length) finish({ outcome: 'completed', ...reached() });
    else tick();
  };

  /** Where the bubble goes for this step; chosen when the step shows, and again when the window or the chat panel changes. */
  let side: Side | undefined;
  /** The chat panel's area, and whether the target had a list open, when `side` was chosen. */
  let chosenWith = '';

  function place(target: Element): void {
    const popup = popupOf(target);
    const face = faceOf(target).getBoundingClientRect();
    const rect = popup ? union(face, popup.getBoundingClientRect()) : face;
    spot.style.left = `${rect.left - PAD}px`;
    spot.style.top = `${rect.top - PAD}px`;
    spot.style.width = `${rect.width + PAD * 2}px`;
    spot.style.height = `${rect.height + PAD * 2}px`;
    const size = bubble.getBoundingClientRect();
    const screen = { width: view.innerWidth, height: view.innerHeight };
    // Scrolled so that it no longer fits, the chat panel opened, folded or closed, or the target
    // opened or closed its list: choose again.
    const panelNow = `${panelKey(document)}|${popup ? 'popup' : ''}`;
    let chosen = side;
    if (!chosen || !position(rect, size, chosen, screen).fits || panelNow !== chosenWith) {
      chosenWith = panelNow;
      chosen = side = chooseSide(target, rect, size, screen);
    }
    const at = bubbleAt(rect, size, chosen, screen);
    bubble.style.top = `${at.top}px`;
    bubble.style.left = `${at.left}px`;
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
        const face = faceOf(current);
        const rect = face.getBoundingClientRect();
        // Off the window: bring it to the middle. In the window, it may still be scrolled away
        // inside a list or a panel that clips it: the least scrolling that shows it (none if shown).
        face.scrollIntoView?.(rect.top < 0 || rect.bottom > view.innerHeight ? { block: 'center' } : { block: 'nearest', inline: 'nearest' });
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
      const on = (target: Element | undefined) => !!target && (target === element || target.contains(element));
      // The current step, or a later one the user got to first: the steps in between count as skipped.
      for (let at = index; at < steps.length; at++) {
        if (steps[at]!.expect === 'ack') continue;
        if (!on(at === index ? current : options.find(at))) continue;
        for (let passed = index; passed < at; passed++) if (steps[passed]!.expect !== 'ack') skipped.push(passed + 1);
        index = at;
        advance();
        return;
      }
      // Otherwise a step that only explains, acted on anyway: done with it too (models mark steps
      // like "turn on Advanced" that way). Last, so that an ack step followed by a step on the
      // same element ("fill in the email" to read, then to do) still goes to the second.
      if (steps[index]!.expect === 'ack' && on(current)) advance();
    },
    stop() {
      finish(undefined);
      return reached();
    },
  };
}
