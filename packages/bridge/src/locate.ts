/**
 * Finding an element again from its locator: the reverse of naming. Used when the element a
 * guide points at was replaced by a re-render.
 */
import type { Locator } from '@doccue/protocol';
import { isIgnored, isVisible, textOf } from './dom.js';
import { clean } from './dom.js';
import { CANDIDATE_SELECTOR, groupOf, isInteractive, locatorOf } from './naming.js';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const GROUP_SELECTOR =
  'dialog, [role="dialog"], [role="alertdialog"], form, fieldset, nav, [role="navigation"], table, [role="table"], [role="grid"], [role="tablist"], [role="menu"], [role="menubar"], ul, ol, menu, [role="list"], [role="listbox"]';

/** A group as a locator: the groups of the screen tree, and lists (which become groups when folded). Rows have no name to find them by. */
function groupLocator(element: Element): Locator | undefined {
  const group = groupOf(element);
  if (group) return group.role === 'row' ? undefined : { role: group.role, name: group.name };
  const role = element.getAttribute('role');
  if (['UL', 'OL', 'MENU'].includes(element.tagName) || role === 'list' || role === 'listbox') return { role: 'list', name: clean(element.getAttribute('aria-label')) };
  return undefined;
}

/** The locator to remember for an element: controls, headings and groups have one; text doesn't. */
export function describeElement(element: Element): Locator | undefined {
  if (isInteractive(element)) return locatorOf(element);
  if (element.matches(HEADING_SELECTOR)) return { role: 'heading', name: textOf(element) };
  return groupLocator(element);
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
  const group = Array.from(document.querySelectorAll(GROUP_SELECTOR)).find((element) => {
    const found = usable(element) ? groupLocator(element) : undefined;
    return found?.role === locator.role && found.name === locator.name;
  });
  if (group) return group;
  const within = JSON.stringify(locator.within ?? []);
  return Array.from(document.querySelectorAll(CANDIDATE_SELECTOR)).find((element) => {
    if (!isInteractive(element) || !usable(element)) return false;
    const found = locatorOf(element);
    return found.role === locator.role && found.name === locator.name && JSON.stringify(found.within ?? []) === within;
  });
}
