/**
 * The screen snapshot: what is visible, as a tree. Headings, groups (dialogs, forms, tables),
 * every control with its current value and state, error messages, notices and short visible
 * text. Controls, headings and groups get a number (`ref`) the model can point at; `elements`
 * maps each number back to its element.
 */
import type { Screen, ScreenNode } from '@doccue/protocol';
import { clean, clip, isIgnored, isScreenReaderOnly, isVisible, textOf } from './dom.js';
import { NOTICE_SELECTOR } from './errors.js';
import { accessibleName, groupOf, hasControlInside, iconOf, isInteractive, roleOf } from './naming.js';

/** Parts of a custom select that are not its choice: live announcements, the placeholder, a shortcut hint. */
const NOT_A_CHOICE = '[aria-live], [role="log"], [role="status"], [role="alert"], [id*="placeholder" i], [class*="placeholder" i], kbd';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'OPTION']);
const TEXT_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'SPAN', 'DIV', 'DD', 'DT', 'SMALL', 'STRONG', 'EM', 'B', 'CAPTION', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'CODE']);
const TEXT_FIELD_TYPES = new Set(['text', 'email', 'number', 'search', 'tel', 'url', 'date', 'datetime-local', 'month', 'time', 'week', 'color', '']);

export interface ScreenOptions {
  errorSelectors: readonly string[];
  /**
   * Nodes kept in the snapshot; the rest are counted in `truncated`. When there are more, open
   * dialogs and messages go first, then what is in view, then what is scrolled away; a node kept
   * keeps its groups around it. Defaults to 300.
   */
  maxNodes?: number;
  /** Rows of a table, or items of a list, listed before the rest are only counted. Defaults to 20. */
  maxRows?: number;
  /** Elements looked at, at most, to stay cheap on huge pages. Defaults to 5000. */
  maxElements?: number;
}

export interface Snapshot {
  screen: Screen;
  /** The element behind each `ref`. */
  elements: Map<number, Element>;
}

/** A node on its way into the snapshot. */
interface Draft {
  node: ScreenNode;
  /** The element, for nodes that get a number. */
  element?: Element;
  /** 0: in an open dialog, or a message; 1: in view; 2: scrolled away. */
  priority: number;
  children: Draft[];
}

/**
 * The choice a custom select shows next to its input. react-select, Ant Design's Select and the
 * like keep the input empty (it is only for typing a filter) and show the chosen option in an
 * element beside it: look for that text in the smallest box around the input that holds no other
 * control and no label or heading.
 */
function shownChoice(input: Element): { text: string; parts: Element[] } | undefined {
  if ((input as HTMLInputElement).value) return undefined;
  const describedBy = (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? input.ownerDocument.getElementById(id) : null))
    .filter((node): node is HTMLElement => node !== null);
  let box: Element = input;
  for (let level = 0; level < 4 && box.parentElement && box.parentElement.tagName !== 'BODY'; level++) {
    box = box.parentElement;
    if (box.tagName === 'LABEL' || box.querySelector('label, h1, h2, h3, h4, h5, h6, [role="heading"]')) return undefined;
    const inside = Array.from(box.querySelectorAll('*'));
    if (inside.some((element) => element !== input && isInteractive(element))) return undefined;
    const parts = inside.filter((element) => {
      if (element.contains(input) || !ownText(element) || !isVisible(element)) return false;
      const excluded = element.closest(NOT_A_CHOICE);
      if (excluded && box.contains(excluded)) return false;
      return !describedBy.some((node) => node.contains(element));
    });
    if (parts.length > 0) return { text: clean(parts.map(ownText).join(' ')), parts };
  }
  return undefined;
}

function controlNode(element: Element, choice?: string): ScreenNode {
  const node: ScreenNode = { role: roleOf(element) };
  const name = accessibleName(element);
  if (name) node.name = name;
  else {
    const icon = iconOf(element);
    if (icon) node.icon = icon;
  }
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
      node.value = clip(field.value || choice || '', 100);
    }
  } else if (tag === 'SELECT') {
    const chosen = Array.from((element as HTMLSelectElement).selectedOptions ?? []).map((option) => clean(option.textContent));
    node.value = clip(chosen.filter(Boolean).join(', '), 100);
  } else if (element.getAttribute('aria-checked') === 'true') {
    states.push('checked');
  } else if (node.role === 'combobox') {
    // A dropdown built from a button, named by its label: the text it shows is the chosen option.
    const shown = textOf(element);
    if (shown && shown !== name) node.value = clip(shown, 100);
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
  const group = groupOf(element);
  return group && { role: group.role, ...(group.name ? { name: group.name } : {}) };
}

/** Text directly inside the element (not inside its child elements). */
function ownText(element: Element): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === 3) text += node.textContent ?? '';
  });
  return clean(text);
}

/** Whether the element is (at least partly) in the viewport; `undefined` without layout (zero size). */
function seen(element: Element): boolean | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return undefined;
  const view = element.ownerDocument.defaultView;
  const height = view?.innerHeight ?? Infinity;
  const width = view?.innerWidth ?? Infinity;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

/** In view, or no way to tell. */
const inView = (element: Element) => seen(element) !== false;

const ROW_CONTAINERS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT']);
const ITEM_CONTAINERS = new Set(['UL', 'OL', 'MENU']);

/** The children of `element` that are rows or list items, if it holds them. */
function itemsOf(element: Element): Element[] {
  const role = element.getAttribute('role') ?? '';
  const rows = ROW_CONTAINERS.has(element.tagName) || ['table', 'grid', 'treegrid', 'rowgroup'].includes(role);
  const items = ITEM_CONTAINERS.has(element.tagName) || ['list', 'listbox', 'menu'].includes(role);
  if (!rows && !items) return [];
  return Array.from(element.children).filter((child) => {
    const childRole = child.getAttribute('role') ?? '';
    return rows ? child.tagName === 'TR' || childRole === 'row' : child.tagName === 'LI' || ['listitem', 'option', 'menuitem'].includes(childRole);
  });
}

/**
 * The rows to list, `max` in all: those in view (the middle ones, if there are more), then the
 * rows just around them; without layout, the first ones.
 */
function pickRows(rows: readonly Element[], max: number): Set<Element> {
  const visible = rows.flatMap((row, index) => (seen(row) === true ? [index] : []));
  if (visible.length === 0) return new Set(rows.slice(0, max));
  const skip = Math.max(0, Math.floor((visible.length - max) / 2));
  let low = visible[skip]!;
  let high = visible[Math.min(visible.length, skip + max) - 1]!;
  while (high - low + 1 < max) {
    if (high + 1 < rows.length) high++;
    if (high - low + 1 < max && low > 0) low--;
    if (low === 0 && high === rows.length - 1) break;
  }
  return new Set(rows.slice(low, high + 1));
}

export function buildScreen(document: Document, options: ScreenOptions): Snapshot {
  const errorSelector = options.errorSelectors.join(', ');
  const maxNodes = options.maxNodes ?? 300;
  const maxRows = options.maxRows ?? 20;
  const maxElements = options.maxElements ?? 5000;
  let visited = 0;

  // Custom selects: their choice goes into their value, and its text is not listed again.
  const choices = new Map<Element, string>();
  const shown = new Set<Element>();
  for (const input of Array.from(document.querySelectorAll('input[role="combobox"]'))) {
    if (isIgnored(input) || !isVisible(input)) continue;
    const choice = shownChoice(input);
    if (!choice) continue;
    choices.set(input, choice.text);
    for (const part of choice.parts) shown.add(part);
  }

  const draft = (out: Draft[], node: ScreenNode, element: Element, numbered: boolean, urgent: boolean): Draft => {
    const made: Draft = { node, priority: urgent ? 0 : inView(element) ? 1 : 2, children: [], ...(numbered ? { element } : {}) };
    out.push(made);
    return made;
  };

  interface Context {
    /** Inside a <label>: its text is the control's name, so only the control itself is listed. */
    inLabel: boolean;
    inDialog: boolean;
    /** The nearest group around, e.g. the table a <tbody> is in. */
    group?: Draft;
  }

  const walk = (element: Element, out: Draft[], context: Context) => {
    if (++visited > maxElements) return;
    const tag = element.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || shown.has(element) || isIgnored(element) || !isVisible(element)) return;

    if (/^H[1-6]$/.test(tag) || element.getAttribute('role') === 'heading') {
      const text = textOf(element);
      if (text) draft(out, { role: 'heading', name: clip(text, 80) }, element, true, context.inDialog);
      return;
    }
    if (isInteractive(element)) {
      draft(out, controlNode(element, choices.get(element)), element, true, context.inDialog);
      return;
    }
    const message = errorSelector && element.matches(errorSelector) ? 'alert' : element.matches(NOTICE_SELECTOR) ? 'status' : undefined;
    // A message is listed as its text. A live region around controls (a whole panel marked
    // aria-live, say) is a group instead, or the controls in it would be lost.
    if (message && !hasControlInside(element)) {
      // Announcements for screen readers only: nothing on screen to point at or read.
      if (isScreenReaderOnly(element)) return;
      const text = textOf(element);
      if (text) draft(out, { role: message, name: clip(text, 200) }, element, false, true);
      return;
    }

    const node = message ? { role: message } : groupNode(element);
    const inDialog = context.inDialog || node?.role === 'dialog';
    let group = node ? draft(out, node, element, true, inDialog || message !== undefined) : undefined;

    // A long table or list: only some rows, and a count of the rest.
    let children = Array.from(element.children);
    const items = itemsOf(element);
    if (items.length > maxRows) {
      const kept = pickRows(items, maxRows);
      children = children.filter((child) => !items.includes(child) || kept.has(child));
      const inTable = ['TBODY', 'THEAD', 'TFOOT'].includes(tag) || element.getAttribute('role') === 'rowgroup';
      const counter = group ?? (inTable && context.group?.node.role === 'table' ? context.group : undefined) ?? (group = draft(out, { role: 'list', ...(clean(element.getAttribute('aria-label')) ? { name: clean(element.getAttribute('aria-label')) } : {}) }, element, true, inDialog));
      counter.node.more = (counter.node.more ?? 0) + items.length - kept.size;
    }

    const childOut = group ? group.children : out;
    const quiet = context.inLabel || tag === 'LABEL';
    if (!quiet && TEXT_TAGS.has(tag)) {
      const text = ownText(element);
      if (text) draft(childOut, { role: 'text', name: clip(text, 120) }, element, false, inDialog);
    }
    const inner: Context = { inLabel: quiet, inDialog, ...(group ? { group } : context.group ? { group: context.group } : {}) };
    for (const child of children) walk(child, childOut, inner);
  };

  const drafts: Draft[] = [];
  if (document.body) for (const child of Array.from(document.body.children)) walk(child, drafts, { inLabel: false, inDialog: false });

  // Over the budget: keep the most important nodes, each with the groups around it.
  const all: Array<{ draft: Draft; parent?: Draft; order: number }> = [];
  const parents = new Map<Draft, Draft | undefined>();
  const collect = (list: Draft[], parent?: Draft) => {
    for (const item of list) {
      parents.set(item, parent);
      all.push({ draft: item, ...(parent ? { parent } : {}), order: all.length });
      collect(item.children, item);
    }
  };
  collect(drafts);
  let keep: Set<Draft> | undefined;
  if (all.length > maxNodes) {
    keep = new Set();
    for (const { draft: candidate } of [...all].sort((a, b) => a.draft.priority - b.draft.priority || a.order - b.order)) {
      if (keep.has(candidate)) continue;
      const chain: Draft[] = [];
      for (let at: Draft | undefined = candidate; at && !keep.has(at); at = parents.get(at)) chain.push(at);
      if (keep.size + chain.length > maxNodes) continue;
      for (const item of chain) keep.add(item);
      if (keep.size >= maxNodes) break;
    }
  }

  // Number what is kept, in page order.
  const elements = new Map<number, Element>();
  const finish = (list: Draft[]): ScreenNode[] =>
    list
      .filter((item) => !keep || keep.has(item))
      .map((item) => {
        let node: ScreenNode = item.node;
        if (item.element) {
          elements.set(elements.size + 1, item.element);
          node = { ref: elements.size, ...node };
        }
        const children = finish(item.children);
        return children.length > 0 ? { ...node, children } : node;
      });
  const nodes = finish(drafts);
  const truncated = keep ? all.length - keep.size : 0;

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
