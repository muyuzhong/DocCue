/**
 * Records what the user does, like analytics autocapture, but as timeline entries a model can
 * read. Each action waits a moment to collect what it caused (errors, notices, dialogs, page
 * changes, failed requests) and carries that as its `result`.
 */
import type { PageInfo, TimelineEntry } from '@doccue/core';
import { clean, clip, isIgnored, isVisible } from './dom.js';
import { collectErrors, collectNotices } from './errors.js';
import { describeControl, dialogTitle, findControl } from './naming.js';

export interface RecorderOptions {
  document: Document;
  errorSelectors: readonly string[];
  /** How long after an action its effects still count as its result. */
  resultWindowMs: number;
  /** Report failed `fetch` / XHR requests. */
  captureNetwork: boolean;
  /** Requests to leave out, e.g. the bridge's own. */
  skipUrl: (url: string) => boolean;
  onEntry: (entry: TimelineEntry) => void;
  onPage: (page: PageInfo) => void;
}

export interface Recorder {
  /** Finish the action in progress now instead of waiting for its result window. */
  flush(): void;
  page(): PageInfo;
  stop(): void;
}

/** An effect is text, or a function giving the text once the action finishes (e.g. a page title
 * that is only set after the URL changed). */
type Effect = string | (() => string);

interface Pending {
  entry: TimelineEntry;
  effects: Effect[];
  timer: ReturnType<typeof setTimeout>;
}

const NON_CLICK_INPUTS = new Set(['text', 'email', 'number', 'search', 'tel', 'url', 'password', 'checkbox', 'radio', 'file', 'range', 'date', 'datetime-local', 'month', 'time', 'week', 'color', '']);

export function createRecorder(options: RecorderOptions): Recorder {
  const { document } = options;
  const view = document.defaultView as (Window & typeof globalThis) | null;
  const cleanups: Array<() => void> = [];
  let pending: Pending | undefined;

  const currentPath = () => `${document.location?.pathname ?? ''}${document.location?.hash ?? ''}`;
  const currentPage = (): PageInfo => {
    const title = clean(document.title);
    return { path: currentPath(), ...(title ? { title } : {}) };
  };
  let lastPage = currentPage();

  const finish = () => {
    if (!pending) return;
    const { entry, effects, timer } = pending;
    clearTimeout(timer);
    pending = undefined;
    const texts = [...new Set(effects.map((effect) => (typeof effect === 'function' ? effect() : effect)))];
    options.onEntry(texts.length > 0 ? { ...entry, result: texts.join('；') } : entry);
  };

  const record = (entry: Omit<TimelineEntry, 'at' | 'page'>) => {
    finish();
    const full: TimelineEntry = { at: Date.now(), page: lastPage.path, ...entry };
    pending = { entry: full, effects: [], timer: setTimeout(finish, options.resultWindowMs) };
  };

  /** Something happened on the page: attach it to the action in progress, or log it on its own. */
  const effect = (text: string, kind: string) => {
    if (pending) {
      if (!pending.effects.includes(text)) pending.effects.push(text);
      return;
    }
    options.onEntry({ at: Date.now(), kind, result: text, page: lastPage.path });
  };

  const listen = <K extends keyof DocumentEventMap>(type: K, handler: (event: DocumentEventMap[K]) => void) => {
    document.addEventListener(type, handler, true);
    cleanups.push(() => document.removeEventListener(type, handler, true));
  };

  // --- user actions ---------------------------------------------------------------------------

  listen('click', (event) => {
    const control = findControl(event);
    if (!control || isIgnored(control)) return;
    const tag = control.tagName;
    // Fields and toggles are recorded when their value changes, not when clicked.
    if (tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (tag === 'INPUT' && NON_CLICK_INPUTS.has((control as HTMLInputElement).type)) return;
    const editable = control.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') return;
    record({ kind: 'click', target: describeControl(control) });
  });

  listen('change', (event) => {
    const field = event.target;
    if (!(field instanceof (view?.HTMLElement ?? HTMLElement)) || isIgnored(field)) return;
    const target = describeControl(field);
    if (field.tagName === 'SELECT') {
      const chosen = Array.from((field as HTMLSelectElement).selectedOptions).map((option) => clean(option.textContent));
      record({ kind: 'select', target, value: chosen.join('、') });
    } else if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
      const input = field as HTMLInputElement;
      if (input.type === 'checkbox') record({ kind: input.checked ? 'check' : 'uncheck', target });
      else if (input.type === 'radio') record({ kind: 'select', target });
      else if (input.type === 'password') record({ kind: 'input', target });
      else if (input.type === 'file') record({ kind: 'input', target, value: `${input.files?.length ?? 0} 个文件` });
      else record({ kind: 'input', target, value: input.value });
    }
  });

  listen('submit', (event) => {
    const form = event.target as Element | null;
    if (!form || isIgnored(form)) return;
    // Usually a click on the submit button already covers it.
    if (pending?.entry.kind === 'click') return;
    const label = clean(form.getAttribute('aria-label'));
    record({ kind: 'submit', target: label ? `表单「${label}」` : '表单' });
  });

  // --- page changes ---------------------------------------------------------------------------

  // Titles of pages we navigated to, read a moment after the URL changed: single-page apps
  // usually set the title right after.
  const titles = new Map<string, string>();
  const pageChanged = () => {
    const path = currentPath();
    if (path === lastPage.path) return;
    // A title equal to the previous page's has not been updated yet: fall back to the path.
    const fromTitle = lastPage.title;
    lastPage = { path };
    // The action in progress right now caused this, even if another one starts before the
    // title is known.
    const owner = pending;
    const label = () => {
      const title = currentPath() === path ? clean(document.title) : '';
      return titles.get(path) || (title && title !== fromTitle ? title : '') || path;
    };
    owner?.effects.push(() => `进入页面「${label()}」`);
    setTimeout(() => {
      if (currentPath() !== path) return;
      const page = currentPage();
      if (page.title) titles.set(path, page.title);
      lastPage = page;
      options.onPage(page);
      if (!owner) options.onEntry({ at: Date.now(), kind: 'navigate', target: label(), page: path });
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
  const errorKey = (error: { text: string; target?: string }) => `${error.text}\u0000${error.target ?? ''}`;
  let knownErrors = new Set(collectErrors(document, options.errorSelectors).map(errorKey));
  let knownNotices = new Set(collectNotices(document));
  let knownDialogs = new Set(dialogs());

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scan = () => {
    scanTimer = undefined;
    const errors = collectErrors(document, options.errorSelectors);
    for (const error of errors) {
      if (!knownErrors.has(errorKey(error))) effect(`出现报错「${error.text}」${error.target ? `（${error.target}）` : ''}`, 'error');
    }
    knownErrors = new Set(errors.map(errorKey));
    const notices = collectNotices(document);
    for (const notice of notices) if (!knownNotices.has(notice)) effect(`提示「${notice}」`, 'notice');
    knownNotices = new Set(notices);
    const open = dialogs();
    for (const title of open) if (!knownDialogs.has(title)) effect(`打开弹窗「${title}」`, 'dialog');
    for (const title of knownDialogs) if (!open.includes(title)) effect(`关闭弹窗「${title}」`, 'dialog');
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

  // --- script errors and failed requests ------------------------------------------------------

  if (view) {
    const onError = (event: ErrorEvent) => {
      if (event.message) effect(`脚本报错：${clip(event.message, 150)}`, 'error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      effect(`脚本报错：${clip(reason, 150)}`, 'error');
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
    const detailOf = (text: string) => {
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
    const failed = (method: string, url: string, status: number, body: string) => {
      const detail = detailOf(body);
      effect(`接口 ${method} ${pathOf(url)} 返回 ${status}${detail ? `：${detail}` : ''}`, 'error');
    };

    const originalFetch = view.fetch;
    if (typeof originalFetch === 'function') {
      view.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
        if (options.skipUrl(url)) return originalFetch.call(this, input, init);
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
          if ((error as { name?: string }).name !== 'AbortError') {
            effect(`接口 ${method} ${pathOf(url)} 请求失败：${clip(error instanceof Error ? error.message : String(error), 120)}`, 'error');
          }
          throw error;
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
          this.addEventListener('loadend', () => {
            if (this.status === 0) effect(`接口 ${info.method} ${pathOf(info.url)} 请求失败`, 'error');
            else if (this.status >= 400) {
              const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
              failed(info.method, info.url, this.status, text);
            }
          });
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
    page: () => lastPage,
    stop() {
      finish();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
