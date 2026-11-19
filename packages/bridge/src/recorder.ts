/**
 * Records what the user does, like analytics autocapture, but as structured timeline entries.
 * Each action waits a moment to collect what it caused (errors, notices, dialogs, page changes,
 * failed requests) and carries that as its `effects`.
 */
import type { ActionType, Effect, Locator, PageInfo, TimelineEntry } from '@doccue/protocol';
import { clean, clip, isIgnored, isVisible } from './dom.js';
import { collectErrors, collectNotices } from './errors.js';
import { accessibleName, dialogTitle, findControl, locatorOf } from './naming.js';

export interface RecorderOptions {
  document: Document;
  errorSelectors: readonly string[];
  /** How long after an action its effects still count as caused by it. */
  resultWindowMs: number;
  /** Report failed `fetch` / XHR requests. */
  captureNetwork: boolean;
  /** Requests to leave out, e.g. the bridge's own. */
  skipUrl: (url: string) => boolean;
  onEntry: (entry: TimelineEntry) => void;
  /**
   * Called right when the user acts on a control, before its effects are known. Picking an option
   * of a custom dropdown calls it for the dropdown and for the option.
   */
  onAction?: (element: Element) => void;
}

export interface Recorder {
  /** Finish the action in progress now instead of waiting for its result window. */
  flush(): void;
  /** Whether requests the page made are still on their way. */
  busy(): boolean;
  stop(): void;
}

/** An effect, or a function giving it once the action finishes (e.g. a page title that is only
 * set after the URL changed). */
type LazyEffect = Effect | (() => Effect);

interface Pending {
  entry: TimelineEntry;
  effects: LazyEffect[];
  timer: ReturnType<typeof setTimeout>;
}

const NON_CLICK_INPUTS = new Set(['text', 'email', 'number', 'search', 'tel', 'url', 'password', 'checkbox', 'radio', 'file', 'range', 'date', 'datetime-local', 'month', 'time', 'week', 'color', '']);

/**
 * The dropdown an option belongs to: the combobox whose list it is in (`aria-controls` or
 * `aria-owns`), the one highlighting it, or the open combobox that has the focus.
 */
function dropdownOf(option: Element): Element | undefined {
  const document = option.ownerDocument;
  const owners = (attribute: string, id: string) =>
    Array.from(document.querySelectorAll(`[${attribute}]`)).find((element) => element.getAttribute(attribute)!.split(/\s+/).includes(id));
  const list = option.closest('[role="listbox"]');
  if (list?.id) {
    const owner = owners('aria-controls', list.id) ?? owners('aria-owns', list.id);
    if (owner) return owner;
  }
  if (option.id) {
    const owner = owners('aria-activedescendant', option.id);
    if (owner) return owner;
  }
  const focused = document.activeElement;
  if (focused?.getAttribute('role') === 'combobox' && focused.getAttribute('aria-expanded') === 'true') return focused;
  return undefined;
}

export function createRecorder(options: RecorderOptions): Recorder {
  const { document } = options;
  const view = document.defaultView as (Window & typeof globalThis) | null;
  const cleanups: Array<() => void> = [];
  let pending: Pending | undefined;
  /** Requests of the page that have not come back yet. */
  let inflight = 0;

  const finish = () => {
    if (!pending) return;
    const { entry, effects, timer } = pending;
    clearTimeout(timer);
    pending = undefined;
    const unique = new Map<string, Effect>();
    for (const lazy of effects) {
      const effect = typeof lazy === 'function' ? lazy() : lazy;
      unique.set(JSON.stringify(effect), effect);
    }
    options.onEntry(unique.size > 0 ? { ...entry, effects: [...unique.values()] } : entry);
  };

  const record = (element: Element, type: ActionType, target: Locator, value?: string, also?: Element) => {
    finish();
    options.onAction?.(element);
    if (also) options.onAction?.(also);
    const entry: TimelineEntry = { at: Date.now(), action: { type, target, ...(value === undefined ? {} : { value }) } };
    pending = { entry, effects: [], timer: setTimeout(finish, options.resultWindowMs) };
  };

  /** Something happened on the page: attach it to the action in progress, or log it on its own. */
  const effect = (happened: Effect) => {
    if (pending) pending.effects.push(happened);
    else options.onEntry({ at: Date.now(), effects: [happened] });
  };

  const listen = <K extends keyof DocumentEventMap>(type: K, handler: (event: DocumentEventMap[K]) => void) => {
    document.addEventListener(type, handler, true);
    cleanups.push(() => document.removeEventListener(type, handler, true));
  };

  // --- user actions ---------------------------------------------------------------------------

  /** A custom dropdown's option was picked: one `select` on the dropdown, with the option as the value. */
  const pick = (option: Element): boolean => {
    const dropdown = dropdownOf(option);
    if (!dropdown || isIgnored(dropdown)) return false;
    record(dropdown, 'select', locatorOf(dropdown), accessibleName(option), option);
    return true;
  };

  listen('click', (event) => {
    const control = findControl(event);
    if (!control || isIgnored(control)) return;
    if (control.getAttribute('role') === 'option' && pick(control)) return;
    const tag = control.tagName;
    // Fields and toggles are recorded when their value changes, not when clicked. A field that
    // takes no typing (read-only, or no keyboard: `inputmode="none"`) is different: clicking it
    // (to open a date picker, say) is what the user does with it.
    if (tag === 'SELECT' || tag === 'TEXTAREA') return;
    const typed = !(control as HTMLInputElement).readOnly && control.getAttribute('inputmode') !== 'none';
    if (tag === 'INPUT' && NON_CLICK_INPUTS.has((control as HTMLInputElement).type) && typed) return;
    const editable = control.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') return;
    record(control, 'click', locatorOf(control));
  });

  // Enter on a dropdown picks the option it has highlighted.
  listen('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const field = event.target as Element | null;
    const active = field?.getAttribute?.('aria-activedescendant');
    if (!field || field.getAttribute('role') !== 'combobox' || !active) return;
    const option = document.getElementById(active);
    if (option?.getAttribute('role') === 'option') pick(option);
  });

  listen('change', (event) => {
    const field = event.target;
    if (!(field instanceof (view?.HTMLElement ?? HTMLElement)) || isIgnored(field)) return;
    const target = locatorOf(field);
    if (field.tagName === 'SELECT') {
      const chosen = Array.from((field as HTMLSelectElement).selectedOptions).map((option) => clean(option.textContent));
      record(field, 'select', target, chosen.join(', '));
    } else if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
      const input = field as HTMLInputElement;
      if (input.type === 'checkbox') record(field, input.checked ? 'check' : 'uncheck', target);
      else if (input.type === 'radio') record(field, 'select', target);
      // A password is recorded as filled in, never with its value.
      else if (input.type === 'password' || input.type === 'file') record(field, 'input', target);
      else record(field, 'input', target, input.value);
    }
  });

  listen('submit', (event) => {
    const form = event.target as Element | null;
    if (!form || isIgnored(form)) return;
    // Usually a click on the submit button already covers it.
    if (pending?.entry.action?.type === 'click') return;
    record(form, 'submit', { role: 'form', name: clean(form.getAttribute('aria-label')) });
  });

  // --- page changes ---------------------------------------------------------------------------

  const currentPath = () => `${document.location?.pathname ?? ''}${document.location?.hash ?? ''}`;
  let lastPath = currentPath();
  let lastTitle = clean(document.title);
  // Titles of pages we navigated to, read a moment after the URL changed: single-page apps
  // usually set the title right after.
  const titles = new Map<string, string>();
  const pageChanged = () => {
    const path = currentPath();
    if (path === lastPath) return;
    // A title equal to the previous page's has not been updated yet: leave it out.
    const fromTitle = lastTitle;
    lastPath = path;
    const page = (): PageInfo => {
      const now = currentPath() === path ? clean(document.title) : '';
      const title = titles.get(path) || (now && now !== fromTitle ? now : '');
      return { path, ...(title ? { title } : {}) };
    };
    // The action in progress right now caused this, even if another one starts before the
    // title is known.
    const owner = pending;
    owner?.effects.push(() => ({ type: 'navigate', page: page() }));
    setTimeout(() => {
      if (currentPath() !== path) return;
      lastTitle = clean(document.title);
      if (lastTitle) titles.set(path, lastTitle);
      if (!owner) options.onEntry({ at: Date.now(), effects: [{ type: 'navigate', page: page() }] });
    }, 50);
  };
  if (view) {
    const history = view.history;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      originalPush.apply(this, args);
      pageChanged();
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      originalReplace.apply(this, args);
      pageChanged();
    };
    view.addEventListener('popstate', pageChanged);
    view.addEventListener('hashchange', pageChanged);
    cleanups.push(() => {
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      view.removeEventListener('popstate', pageChanged);
      view.removeEventListener('hashchange', pageChanged);
    });
  }

  // --- errors, notices and dialogs appearing --------------------------------------------------

  const dialogs = () =>
    Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog'))
      .filter((dialog) => !isIgnored(dialog) && isVisible(dialog))
      .map(dialogTitle);
  let knownErrors = new Set(collectErrors(document, options.errorSelectors).map((error) => JSON.stringify(error)));
  let knownNotices = new Set(collectNotices(document));
  let knownDialogs = new Set(dialogs());

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scan = () => {
    scanTimer = undefined;
    const errors = collectErrors(document, options.errorSelectors);
    for (const error of errors) if (!knownErrors.has(JSON.stringify(error))) effect({ type: 'error', ...error });
    knownErrors = new Set(errors.map((error) => JSON.stringify(error)));
    const notices = collectNotices(document);
    for (const text of notices) if (!knownNotices.has(text)) effect({ type: 'notice', text });
    knownNotices = new Set(notices);
    const open = dialogs();
    for (const name of open) if (!knownDialogs.has(name)) effect({ type: 'dialog', state: 'opened', name });
    for (const name of knownDialogs) if (!open.includes(name)) effect({ type: 'dialog', state: 'closed', name });
    knownDialogs = new Set(open);
  };
  if (view?.MutationObserver && document.body) {
    const observer = new view.MutationObserver(() => {
      scanTimer ??= setTimeout(scan, 30);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-invalid', 'aria-hidden'] });
    cleanups.push(() => {
      observer.disconnect();
      clearTimeout(scanTimer);
    });
  }

  // --- leaving the page ----------------------------------------------------------------------

  // A click that loads a new page (a plain link, a form that posts) has no time to wait for its
  // effects: record it before the page goes.
  if (view) {
    view.addEventListener('pagehide', finish);
    cleanups.push(() => view.removeEventListener('pagehide', finish));
  }

  // --- script errors and failed requests ------------------------------------------------------

  if (view) {
    const onError = (event: ErrorEvent) => {
      if (event.message) effect({ type: 'script_error', message: clip(event.message, 150) });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      effect({ type: 'script_error', message: clip(reason, 150) });
    };
    view.addEventListener('error', onError);
    view.addEventListener('unhandledrejection', onRejection);
    cleanups.push(() => {
      view.removeEventListener('error', onError);
      view.removeEventListener('unhandledrejection', onRejection);
    });
  }

  if (view && options.captureNetwork) {
    const pathOf = (url: string) => {
      try {
        const parsed = new URL(url, document.location?.href);
        return parsed.origin === document.location?.origin ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
      } catch {
        return url;
      }
    };
    /** The server's own message, if the body is JSON with one of the usual fields. */
    const messageOf = (text: string) => {
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        for (const key of ['message', 'error', 'detail', 'msg']) {
          const value = body[key];
          if (typeof value === 'string' && value) return clip(value, 120);
        }
      } catch {
        // Not JSON.
      }
      return clip(clean(text), 120);
    };
    const failed = (method: string, url: string, status: number | undefined, body: string) => {
      const message = messageOf(body);
      effect({ type: 'request_failed', method, path: pathOf(url), ...(status === undefined ? {} : { status }), ...(message ? { message } : {}) });
    };

    const originalFetch = view.fetch;
    if (typeof originalFetch === 'function') {
      view.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
        if (options.skipUrl(url)) return originalFetch.call(this, input, init);
        inflight++;
        try {
          const response = await originalFetch.call(this, input, init);
          if (!response.ok) {
            void response
              .clone()
              .text()
              .then((body) => failed(method, url, response.status, body))
              .catch(() => failed(method, url, response.status, ''));
          }
          return response;
        } catch (error) {
          if ((error as { name?: string }).name !== 'AbortError') failed(method, url, undefined, error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          inflight--;
        }
      } as typeof fetch;
      cleanups.push(() => {
        view.fetch = originalFetch;
      });
    }

    const XHR = view.XMLHttpRequest;
    if (XHR) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        meta.set(this, { method: method.toUpperCase(), url: String(url) });
        return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
      } as XMLHttpRequest['open'];
      XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const info = meta.get(this);
        if (info && !options.skipUrl(info.url)) {
          let aborted = false;
          const onAbort = () => {
            aborted = true;
          };
          const onEnd = () => {
            inflight--;
            this.removeEventListener('abort', onAbort);
            if (aborted) return;
            if (this.status === 0) failed(info.method, info.url, undefined, '');
            else if (this.status >= 400) {
              const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
              failed(info.method, info.url, this.status, text);
            }
          };
          this.addEventListener('abort', onAbort, { once: true });
          this.addEventListener('loadend', onEnd, { once: true });
          inflight++;
          try {
            return originalSend.call(this, body);
          } catch (error) {
            inflight--;
            this.removeEventListener('abort', onAbort);
            this.removeEventListener('loadend', onEnd);
            throw error;
          }
        }
        return originalSend.call(this, body);
      };
      cleanups.push(() => {
        XHR.prototype.open = originalOpen;
        XHR.prototype.send = originalSend;
      });
    }
  }

  return {
    flush: finish,
    busy: () => inflight > 0,
    stop() {
      finish();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
