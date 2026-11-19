/**
 * Finds the control a user interacted with and describes it the way a screen reader would: an
 * ARIA role plus the name shown on screen, e.g. `{ role: 'button', name: '测试连接' }`, with the
 * dialog, table row or section around it when that is needed to tell it apart.
 */
import type { Locator, Region } from '@doccue/protocol';
import { clean, clip, isElement, isVisible, textOf } from './dom.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'treeitem',
]);

/** Roles of `<input>` types that are not plain text fields. */
const INPUT_ROLES: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  file: 'button',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog';

/** Selector for anything that might be a control; filter the matches with `isInteractive`. */
export const CANDIDATE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role], [tabindex], [contenteditable]';

export function isInteractive(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'a') return element.hasAttribute('href');
  if (tag === 'input') return (element as HTMLInputElement).type !== 'hidden';
  const role = element.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const editable = element.getAttribute('contenteditable');
  if (editable !== null && editable !== 'false') return true;
  const tabindex = element.getAttribute('tabindex');
  // A cell of a grid the user picks from (a date picker's day) takes the focus; the cells of a
  // data grid don't (only the one in focus has tabindex 0, the rest -1), and stay text.
  if (role === 'gridcell') return tabindex !== null && Number(tabindex) >= 0 && !hasControlInside(element);
  // A tabindex only makes an element focusable. Scroll areas, code blocks, dialog wrappers and
  // focus traps carry one too, so on its own it counts only for something without a role of its
  // own that looks clickable and holds no controls: a clickable <div> standing in for a button.
  if (role) return false;
  if (tabindex === null || !(Number(tabindex) >= 0)) return false;
  return looksClickable(element) && !hasControlInside(element);
}

/** A pointer cursor or an inline click handler: what a clickable element without a role has. */
function looksClickable(element: Element): boolean {
  if (element.hasAttribute('onclick')) return true;
  const view = element.ownerDocument.defaultView;
  return !view || view.getComputedStyle(element).cursor === 'pointer';
}

/** Whether a control sits somewhere inside the element. */
export function hasControlInside(element: Element): boolean {
  return Array.from(element.querySelectorAll(CANDIDATE_SELECTOR)).some(isInteractive);
}

/** The control an event happened on: the nearest interactive element along its path. */
export function findControl(event: Event): Element | undefined {
  for (const node of event.composedPath()) {
    if (!isElement(node)) continue;
    if (isInteractive(node)) return node;
    if (node.tagName === 'BODY') break;
  }
  return undefined;
}

/** The ARIA role: an explicit interactive `role`, or the one the tag implies. */
export function roleOf(element: Element): string {
  const role = element.getAttribute('role');
  if (role && (INTERACTIVE_ROLES.has(role) || role === 'gridcell')) return role;
  switch (element.tagName.toLowerCase()) {
    case 'button':
    case 'summary':
      return 'button';
    case 'a':
      return 'link';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input':
      return INPUT_ROLES[(element as HTMLInputElement).type] ?? 'textbox';
    default:
      return element.hasAttribute('contenteditable') ? 'textbox' : 'generic';
  }
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'HEADER', 'FOOTER', 'TABLE', 'TR', 'TD', 'TH', 'BR']);

/** A character count shown in a label ("6/255", "0/1000 (min 1)"): it changes as the user types, so it is no part of the name. */
const COUNTER = /^\d+\s*\/\s*\d+(?!\d)/;

/** Text of a `<label>`, without the text of controls nested in it (e.g. a select's options) or a character count. */
function labelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  copy.querySelectorAll('input, select, textarea, button').forEach((control) => control.remove());
  copy.querySelectorAll('*').forEach((part) => {
    if (part.children.length === 0 && COUNTER.test(clean(part.textContent))) part.remove();
  });
  // The copy has no layout: keep block parts apart ("Limit" and its description below it), as
  // the page shows them, instead of running them together.
  copy.querySelectorAll('*').forEach((element) => {
    if (BLOCK_TAGS.has(element.tagName)) element.after(' ');
  });
  // The asterisk of a required field is not part of its name.
  return clean(copy.textContent).replace(/^\*\s*|\s*\*$/g, '');
}

/** Roles of controls that hold a value or a state: a `<label>` names them even when they are a `<button>`. */
const LABELLED_ROLES = new Set(['checkbox', 'radio', 'switch', 'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'listbox']);

/**
 * Text of the `<label>` elements tied to the element (`for`, or wrapped around it); else of a
 * label whose `for` points at a wrapper holding just this control. Browsers tie such a label to
 * nothing (a `<div>` can't be labelled), but on screen it names the field in the wrapper.
 */
function labelsOf(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  const text = labels ? clean(Array.from(labels).map(labelText).join(' ')) : '';
  if (text) return text;
  let node = element.parentElement;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    if (!node.id) continue;
    const id = node.id;
    const label = Array.from(element.ownerDocument.querySelectorAll('label[for]')).find((candidate) => candidate.getAttribute('for') === id);
    if (!label) continue;
    const controls = Array.from(node.querySelectorAll(CANDIDATE_SELECTOR)).filter(isInteractive);
    return controls.length === 1 ? labelText(label) : '';
  }
  return '';
}

/**
 * A `<label>` tied to nothing (no `for`, or one pointing nowhere) that a person reads as the
 * control's name: right before or after the control ("Preview" next to a checkbox), or right
 * before a box that holds just this control (a date picker's input inside its widget).
 */
function looseLabel(element: Element): string {
  const loose = (node: Element | null) =>
    node?.tagName === 'LABEL' && !(node as HTMLLabelElement).control && !hasControlInside(node) ? labelText(node) : '';
  const beside = loose(element.previousElementSibling) || loose(element.nextElementSibling);
  if (beside) return beside;
  let box = element.parentElement;
  for (let depth = 0; box && box.tagName !== 'BODY' && depth < 4; depth++, box = box.parentElement) {
    if (Array.from(box.querySelectorAll(CANDIDATE_SELECTOR)).filter(isInteractive).length > 1) break;
    const before = loose(box.previousElementSibling);
    if (before) return before;
  }
  return '';
}

/** The accessible name, roughly as a screen reader would announce it. */
export function accessibleName(element: Element): string {
  const document = element.ownerDocument;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = clean(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map(textOf)
        .join(' '),
    );
    if (text) return clip(text, 40);
  }
  const tag = element.tagName.toLowerCase();
  const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
  // A field's own visible label beats its aria-label: the guide's bubble should use the words the
  // user sees next to it (Grafana labels a field "Prometheus server URL" and aria-labels it
  // "Data source connection URL").
  // The same for a button standing in for a field (a custom dropdown, switch or checkbox): its
  // label names it, and the text inside it is its value.
  if (isField || (tag === 'button' && LABELLED_ROLES.has(roleOf(element)))) {
    const fromLabels = labelsOf(element) || looseLabel(element);
    if (fromLabels) return clip(fromLabels, 40);
  }
  const ariaLabel = clean(element.getAttribute('aria-label'));
  if (ariaLabel) return clip(ariaLabel, 40);

  if (isField) {
    const field = element as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(field.type) && clean(field.value)) return clip(clean(field.value), 40);
    if (field.type === 'image' && clean(field.alt)) return clip(clean(field.alt), 40);
    for (const candidate of [field.getAttribute('placeholder'), field.getAttribute('title')]) {
      if (clean(candidate)) return clip(clean(candidate), 40);
    }
  } else {
    const text = textOf(element);
    if (text) return clip(text, 40);
    const title = clean(element.getAttribute('title'));
    if (title) return clip(title, 40);
    const image = element.querySelector('img[alt], [aria-label], svg title');
    const inner = image ? clean(image.getAttribute('alt') ?? image.getAttribute('aria-label') ?? image.textContent) : '';
    if (inner) return clip(inner, 40);
    const fromLabels = labelsOf(element);
    if (fromLabels) return clip(fromLabels, 40);
  }
  const loose = looseLabel(element);
  if (loose) return clip(loose, 40);
  // Last resort: the field's technical name.
  return clean(element.getAttribute('name'));
}

/** Icon set prefixes in class names and icon ids: `lucide-trash`, `fa-trash`, `mdi-qrcode`, `bi-x`. */
const ICON_PREFIX = /^(?:lucide|fa[srlbd]?|bi|mdi|ti|tabler|ri|ph|icon|iconify|heroicons?|feather|octicon|codicon|bx[sl]?|uil|la[srb]?|glyphicon|ion|ionicon|carbon|fluent|ic|material-symbols|i-[a-z]+)[-:](.+)$/i;
/** Class names in those sets that are a style or a size, not an icon. */
const NOT_AN_ICON = /^(?:solid|regular|light|thin|duotone|brands|sharp|fw|xs|sm|lg|xl|[0-9]+x|spin|pulse|inverse|border|stack|outline|filled|rounded|icon)$/i;

/** `mdi-file-download` → `file download`; `undefined` when it isn't an icon's name. */
function iconName(raw: string | null | undefined, prefixed: boolean): string | undefined {
  let id = clean(raw).split(/[\/#]/).pop()!.replace(/\.svg$/i, '');
  const match = ICON_PREFIX.exec(id);
  if (match) id = match[1]!;
  else if (prefixed) return undefined;
  id = id.replace(/^[a-z0-9]+:/i, '').replace(/-icon$/i, '');
  if (!id || NOT_AN_ICON.test(id) || !/^[a-z][a-z0-9_-]{1,40}$/i.test(id)) return undefined;
  return id.replace(/[-_]+/g, ' ').toLowerCase();
}

/**
 * What the icon of a control without a name is called in the page's code: icon sets put it in a
 * class (`lucide-trash`), an attribute (`data-icon`, `name`, `icon`), a sprite reference
 * (`<use href="#icon-trash">`) or an image's file name. Empty when there is none.
 */
export function iconOf(element: Element): string {
  for (const icon of Array.from(element.querySelectorAll('svg, i, span, img, use, iconify-icon, ion-icon, [data-icon]')).slice(0, 6)) {
    const named =
      iconName(icon.getAttribute('data-icon'), false) ??
      iconName(icon.getAttribute('data-lucide'), false) ??
      (icon.tagName === 'ICONIFY-ICON' || icon.tagName === 'ION-ICON' ? iconName(icon.getAttribute('icon') ?? icon.getAttribute('name'), false) : undefined) ??
      (icon.tagName.toLowerCase() === 'svg' || icon.tagName === 'I' ? iconName(icon.getAttribute('name'), true) : undefined) ??
      (icon.tagName.toLowerCase() === 'use' ? iconName(icon.getAttribute('href') ?? icon.getAttribute('xlink:href'), false) : undefined) ??
      (icon.tagName === 'IMG' && !clean(icon.getAttribute('alt')) ? iconName(icon.getAttribute('src'), false) : undefined) ??
      Array.from(icon.classList)
        .map((name) => iconName(name, true))
        .find(Boolean);
    if (named) return named;
  }
  return '';
}

function headingNear(element: Element): string | undefined {
  for (let node = element.parentElement; node && node.tagName !== 'BODY'; node = node.parentElement) {
    const label = clean(node.getAttribute('aria-label'));
    if (label && (node.tagName === 'FORM' || node.tagName === 'SECTION' || node.getAttribute('role') === 'region')) return label;
    for (const child of Array.from(node.children)) {
      if (child.contains(element)) break;
      if (/^H[1-6]$/.test(child.tagName) || child.tagName === 'LEGEND' || child.getAttribute('role') === 'heading') {
        const text = textOf(child);
        if (text) return clip(text, 30);
      }
    }
  }
  return undefined;
}

/**
 * The group an element forms, if any: a dialog, form, fieldset, navigation, table, row, tab list
 * or menu, with its name. Used for the screen tree and to find a group again.
 */
export function groupOf(element: Element): { role: string; name: string } | undefined {
  const tag = element.tagName;
  const role = element.getAttribute('role');
  const label = clean(element.getAttribute('aria-label'));
  if (role === 'dialog' || role === 'alertdialog' || tag === 'DIALOG') return { role: 'dialog', name: dialogTitle(element) };
  if (tag === 'FORM') return { role: 'form', name: label };
  if (tag === 'FIELDSET') {
    const legend = element.querySelector('legend');
    return { role: 'group', name: legend ? textOf(legend) : label };
  }
  if (tag === 'NAV' || role === 'navigation') return { role: 'navigation', name: label };
  if (tag === 'TABLE' || role === 'table' || role === 'grid') return { role: 'table', name: label };
  if (tag === 'TR' || role === 'row') return { role: 'row', name: '' };
  if (role === 'tablist') return { role: 'tablist', name: label };
  if (role === 'menu' || role === 'menubar') return { role: 'menu', name: label };
  return undefined;
}

export function dialogTitle(dialog: Element): string {
  const labelledBy = dialog.getAttribute('aria-labelledby');
  const byId = labelledBy ? dialog.ownerDocument.getElementById(labelledBy.split(/\s+/)[0] ?? '') : null;
  const heading = byId ?? dialog.querySelector('h1, h2, h3, h4, [role="heading"]');
  return clip(clean(dialog.getAttribute('aria-label')) || (heading ? textOf(heading) : ''), 30);
}

function sameName(element: Element, name: string, role: string): number {
  if (!name) return 0;
  let count = 0;
  for (const other of Array.from(element.ownerDocument.querySelectorAll(CANDIDATE_SELECTOR))) {
    if (isInteractive(other) && roleOf(other) === role && accessibleName(other) === name && isVisible(other)) count++;
  }
  return count;
}

/** Text that identifies the table row or list item the control is in. */
function rowKey(element: Element): string | undefined {
  const row = element.closest('tr, [role="row"], li, [role="listitem"]');
  if (!row) return undefined;
  for (const cell of Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'))) {
    if (cell.contains(element)) continue;
    const text = textOf(cell);
    if (text) return clip(text, 30);
  }
  const copy = row.cloneNode(true) as Element;
  copy.querySelectorAll(CANDIDATE_SELECTOR).forEach((control) => control.remove());
  const text = clean(copy.textContent);
  return text ? clip(text, 30) : undefined;
}

/**
 * The control as a locator: role and name, the dialog it is in and, when the same name appears
 * more than once on the page, the row or section it belongs to.
 */
export function locatorOf(element: Element): Locator {
  const role = roleOf(element);
  const name = accessibleName(element);
  const within: Region[] = [];
  const dialog = element.closest(DIALOG_SELECTOR);
  if (dialog) within.push({ kind: 'dialog', name: dialogTitle(dialog) });
  if (sameName(element, name, role) > 1) {
    const row = rowKey(element);
    const section = row ? undefined : headingNear(element);
    if (row) within.push({ kind: 'row', name: row });
    else if (section) within.push({ kind: 'section', name: section });
  }
  const icon = name ? '' : iconOf(element);
  const id = element.getAttribute('data-cue-id');
  return { role, name, ...(icon ? { icon } : {}), ...(within.length > 0 ? { within } : {}), ...(id ? { id } : {}) };
}
