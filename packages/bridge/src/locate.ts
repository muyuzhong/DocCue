/**
 * Finding an element again from its locator: the reverse of naming. Used when the element a
 * guide points at was replaced by a re-render.
 */
import type { Locator } from '@doccue/protocol';
import { isIgnored, isVisible, textOf } from './dom.js';
import { CANDIDATE_SELECTOR, isInteractive, locatorOf } from './naming.js';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

/** The locator to remember for an element: controls and headings have one, other nodes don't. */
export function describeElement(element: Element): Locator | undefined {
  if (isInteractive(element)) return locatorOf(element);
  if (element.matches(HEADING_SELECTOR)) return { role: 'heading', name: textOf(element) };
  return undefined;
}

export function findByLocator(document: Document, locator: Locator): Element | undefined {
  const usable = (element: Element) => !isIgnored(element) && isVisible(element);
  if (locator.id) {
    const byId = Array.from(document.querySelectorAll('[data-cue-id]')).find((element) => element.getAttribute('data-cue-id') === locator.id);
    if (byId && usable(byId)) return byId;
  }
  if (locator.role === 'heading') {
    return Array.from(document.querySelectorAll(HEADING_SELECTOR)).find((element) => usable(element) && textOf(element) === locator.name);
  }
  const within = JSON.stringify(locator.within ?? []);
  return Array.from(document.querySelectorAll(CANDIDATE_SELECTOR)).find((element) => {
    if (!isInteractive(element) || !usable(element)) return false;
    const found = locatorOf(element);
    return found.role === locator.role && found.name === locator.name && JSON.stringify(found.within ?? []) === within;
  });
}
