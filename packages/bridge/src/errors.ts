/** Finds error messages and notices currently shown on the page. */
import type { ActiveError } from '@doccue/core';
import { clip, isIgnored, isVisible, textOf } from './dom.js';
import { CANDIDATE_SELECTOR, accessibleName, describeControl, isInteractive } from './naming.js';

/** Where error messages usually live: generic markers plus common UI libraries. */
export const DEFAULT_ERROR_SELECTORS = [
  '[data-cue-error]',
  '[role="alert"]',
  '.invalid-feedback', // Bootstrap
  '.ant-form-item-explain-error', // Ant Design
  '.el-form-item__error', // Element Plus
  '.MuiFormHelperText-root.Mui-error', // MUI
];

const NOTICE_SELECTOR = '[role="status"], [aria-live="polite"]';

/** The control an error message belongs to, if it can be told. */
function errorTarget(message: Element): string | undefined {
  const document = message.ownerDocument;
  if (message.id) {
    const id = message.id.replace(/["\\]/g, '\\$&');
    const control = document.querySelector(`[aria-describedby~="${id}"], [aria-errormessage="${id}"]`);
    if (control) return describeControl(control);
  }
  // Otherwise the closest container that holds exactly one control.
  let node = message.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const controls = Array.from(node.querySelectorAll(CANDIDATE_SELECTOR)).filter(
      (candidate) => candidate !== message && isInteractive(candidate) && isVisible(candidate),
    );
    if (controls.length === 1 && controls[0]) return describeControl(controls[0]);
    if (controls.length > 1) return undefined;
  }
  return undefined;
}

/** Visible error messages, each tied to its control when possible. */
export function collectErrors(document: Document, selectors: readonly string[]): ActiveError[] {
  const errors: ActiveError[] = [];
  const seen = new Set<string>();
  const add = (error: ActiveError) => {
    const key = `${error.text}\u0000${error.target ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(error);
  };
  for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
    if (isIgnored(element) || !isVisible(element)) continue;
    const text = textOf(element);
    if (!text) continue;
    const target = errorTarget(element);
    add({ text: clip(text, 200), source: 'page', ...(target ? { target } : {}) });
  }
  // Fields marked invalid that have no message of their own.
  for (const field of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    if (isIgnored(field) || !isVisible(field)) continue;
    const target = describeControl(field);
    if (errors.some((error) => error.target === target)) continue;
    add({ text: `${accessibleName(field) || '这一项'}填写有误`, target, source: 'page' });
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
