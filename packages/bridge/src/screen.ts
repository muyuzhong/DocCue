/**
 * The screen snapshot: what is visible, as a tree. Headings, groups (dialogs, forms, tables),
 * every control with its current value and state, error messages, notices and short visible
 * text. Controls, headings and groups get a number (`ref`) the model can point at; `elements`
 * maps each number back to its element.
 */
import type { Screen, ScreenNode } from '@doccue/protocol';
import { clean, clip, isIgnored, isVisible, textOf } from './dom.js';
import { NOTICE_SELECTOR } from './errors.js';
import { accessibleName, dialogTitle, hasControlInside, isInteractive, roleOf } from './naming.js';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'OPTION']);
const TEXT_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'SPAN', 'DIV', 'DD', 'DT', 'SMALL', 'STRONG', 'EM', 'B', 'CAPTION', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'CODE']);
const TEXT_FIELD_TYPES = new Set(['text', 'email', 'number', 'search', 'tel', 'url', 'date', 'datetime-local', 'month', 'time', 'week', 'color', '']);

export interface ScreenOptions {
  errorSelectors: readonly string[];
  /** Nodes kept in the snapshot; the rest are counted in `truncated`. Defaults to 300. */
  maxNodes?: number;
}

export interface Snapshot {
  screen: Screen;
  /** The element behind each `ref`. */
  elements: Map<number, Element>;
}

function controlNode(element: Element): ScreenNode {
  const node: ScreenNode = { role: roleOf(element) };
  const name = accessibleName(element);
  if (name) node.name = name;
  const states: string[] = [];
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const field = element as HTMLInputElement;
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.checked) states.push('checked');
    } else if (field.type === 'password') {
      states.push('password');
      if (field.value) states.push('filled');
    } else if (TEXT_FIELD_TYPES.has(field.type) || tag === 'TEXTAREA') {
      node.value = clip(field.value, 100);
    }
  } else if (tag === 'SELECT') {
    const chosen = Array.from((element as HTMLSelectElement).selectedOptions ?? []).map((option) => clean(option.textContent));
    node.value = clip(chosen.filter(Boolean).join(', '), 100);
  } else if (element.getAttribute('aria-checked') === 'true') {
    states.push('checked');
  }
  if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if (element.getAttribute('aria-selected') === 'true' || element.hasAttribute('aria-current')) states.push('current');
  const expanded = element.getAttribute('aria-expanded');
  if (expanded) states.push(expanded === 'true' ? 'expanded' : 'collapsed');
  if (element.getAttribute('aria-invalid') === 'true') states.push('invalid');
  if (states.length > 0) node.states = states;
  return node;
}

function groupNode(element: Element): ScreenNode | undefined {
  const tag = element.tagName;
  const role = element.getAttribute('role');
  const label = clean(element.getAttribute('aria-label'));
  const named = (groupRole: string, name: string): ScreenNode => ({ role: groupRole, ...(name ? { name } : {}) });
  if (role === 'dialog' || role === 'alertdialog' || tag === 'DIALOG') return named('dialog', dialogTitle(element));
  if (tag === 'FORM') return named('form', label);
  if (tag === 'FIELDSET') {
    const legend = element.querySelector('legend');
    return named('group', legend ? textOf(legend) : label);
  }
  if (tag === 'NAV' || role === 'navigation') return named('navigation', label);
  if (tag === 'TABLE' || role === 'table' || role === 'grid') return named('table', label);
  if (tag === 'TR' || role === 'row') return named('row', '');
  if (role === 'tablist') return named('tablist', label);
  if (role === 'menu' || role === 'menubar') return named('menu', label);
  return undefined;
}

/** Text directly inside the element (not inside its child elements). */
function ownText(element: Element): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === 3) text += node.textContent ?? '';
  });
  return clean(text);
}

export function buildScreen(document: Document, options: ScreenOptions): Snapshot {
  const errorSelector = options.errorSelectors.join(', ');
  const maxNodes = options.maxNodes ?? 300;
  const elements = new Map<number, Element>();
  const nodes: ScreenNode[] = [];
  let count = 0;
  let truncated = 0;

  /** Adds a node to `out`; with `element`, the node gets a number. */
  const add = (out: ScreenNode[], node: ScreenNode, element?: Element): ScreenNode | undefined => {
    if (count >= maxNodes) {
      truncated++;
      return undefined;
    }
    count++;
    const numbered = element ? { ref: elements.size + 1, ...node } : node;
    if (element) elements.set(elements.size + 1, element);
    out.push(numbered);
    return numbered;
  };

  // Inside a <label> the text is the control's name, so only the control itself is listed.
  const walk = (element: Element, out: ScreenNode[], inLabel = false) => {
    const tag = element.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || isIgnored(element) || !isVisible(element)) return;

    if (/^H[1-6]$/.test(tag) || element.getAttribute('role') === 'heading') {
      const text = textOf(element);
      if (text) add(out, { role: 'heading', name: clip(text, 80) }, element);
      return;
    }
    if (isInteractive(element)) {
      add(out, controlNode(element), element);
      return;
    }
    const message = errorSelector && element.matches(errorSelector) ? 'alert' : element.matches(NOTICE_SELECTOR) ? 'status' : undefined;
    // A message is listed as its text. A live region around controls (a whole panel marked
    // aria-live, say) is a group instead, or the controls in it would be lost.
    if (message && !hasControlInside(element)) {
      const text = textOf(element);
      if (text) add(out, { role: message, name: clip(text, 200) });
      return;
    }

    const group = message ? { role: message } : groupNode(element);
    const added = group ? add(out, group, element) : undefined;
    const children: ScreenNode[] = [];
    const childOut = added ? children : out;
    const quiet = inLabel || tag === 'LABEL';
    if (!quiet && TEXT_TAGS.has(tag)) {
      const text = ownText(element);
      if (text) add(childOut, { role: 'text', name: clip(text, 120) });
    }
    for (const child of Array.from(element.children)) walk(child, childOut, quiet);
    if (added && children.length > 0) added.children = children;
  };

  if (document.body) for (const child of Array.from(document.body.children)) walk(child, nodes);
  const title = clean(document.title);
  return {
    screen: {
      page: { path: `${document.location?.pathname ?? ''}${document.location?.hash ?? ''}`, ...(title ? { title } : {}) },
      nodes,
      ...(truncated > 0 ? { truncated } : {}),
    },
    elements,
  };
}
