/** Finds error messages and notices currently shown on the page. */
import type { Locator } from '@doccue/protocol';
import { clip, isIgnored, isVisible, textOf } from './dom.js';
import { CANDIDATE_SELECTOR, isInteractive, locatorOf } from './naming.js';

/** Where error messages usually live: generic markers plus common UI libraries. */
export const DEFAULT_ERROR_SELECTORS = [
  '[data-cue-error]',
  '[role="alert"]',
  '.invalid-feedback', // Bootstrap
  '.ant-form-item-explain-error', // Ant Design
  '.el-form-item__error', // Element Plus
  '.MuiFormHelperText-root.Mui-error', // MUI
];

export const NOTICE_SELECTOR = '[role="status"], [aria-live="polite"]';

/** An error message visible on the page, with the control it belongs to when that can be told. */
export interface PageError {
  text: string;
  target?: Locator;
}

/** The control an error message belongs to, if it can be told. */
function errorTarget(message: Element): Locator | undefined {
  const document = message.ownerDocument;
  if (message.id) {
    const id = message.id.replace(/["\\]/g, '\\$&');
    const control = document.querySelector(`[aria-describedby~="${id}"], [aria-errormessage="${id}"]`);
    if (control) return locatorOf(control);
  }
  // Otherwise the closest container that holds exactly one control.
  let node = message.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const controls = Array.from(node.querySelectorAll(CANDIDATE_SELECTOR)).filter(
      (candidate) => candidate !== message && isInteractive(candidate) && isVisible(candidate),
    );
    if (controls.length === 1 && controls[0]) return locatorOf(controls[0]);
    if (controls.length > 1) return undefined;
  }
  return undefined;
}

/** Visible error messages, each tied to its control when possible. */
export function collectErrors(document: Document, selectors: readonly string[]): PageError[] {
  const errors: PageError[] = [];
  const seen = new Set<string>();
  if (selectors.length === 0) return errors;
  for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
    if (isIgnored(element) || !isVisible(element)) continue;
    const text = textOf(element);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const target = errorTarget(element);
    errors.push({ text: clip(text, 200), ...(target ? { target } : {}) });
  }
  return errors;
}

/** Visible status messages, such as a "saved" toast. */
export function collectNotices(document: Document): string[] {
  const notices: string[] = [];
  for (const element of Array.from(document.querySelectorAll(NOTICE_SELECTOR))) {
    if (isIgnored(element) || !isVisible(element)) continue;
    const text = textOf(element);
    if (text && !notices.includes(text)) notices.push(clip(text, 200));
  }
  return notices;
}
