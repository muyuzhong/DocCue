/**
 * Finds the control a user interacted with and names it for humans and models, e.g.
 * `按钮「测试连接」`, `弹窗「新建数据源」 › 按钮「保存」`, `「mysql-prod」这一行 › 按钮「删除」`.
 */
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

const ROLE_LABELS: Record<string, string> = {
  button: '按钮',
  link: '链接',
  checkbox: '复选框',
  radio: '单选框',
  switch: '开关',
  tab: '标签页',
  menuitem: '菜单项',
  menuitemcheckbox: '菜单项',
  menuitemradio: '菜单项',
  option: '选项',
  combobox: '下拉框',
  textbox: '输入框',
  searchbox: '搜索框',
  slider: '滑块',
  spinbutton: '数字框',
  treeitem: '树节点',
};

const INPUT_LABELS: Record<string, string> = {
  checkbox: '复选框',
  radio: '单选框',
  password: '密码框',
  button: '按钮',
  submit: '按钮',
  reset: '按钮',
  image: '按钮',
  range: '滑块',
  file: '文件选择',
  search: '搜索框',
};

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
  return tabindex !== null && Number(tabindex) >= 0;
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

/** `按钮`, `输入框`, `下拉框`, ... */
export function controlRole(element: Element): string {
  const role = element.getAttribute('role');
  if (role && ROLE_LABELS[role]) return ROLE_LABELS[role];
  switch (element.tagName.toLowerCase()) {
    case 'button':
      return '按钮';
    case 'summary':
      return '折叠项';
    case 'a':
      return '链接';
    case 'select':
      return '下拉框';
    case 'textarea':
      return '文本框';
    case 'input':
      return INPUT_LABELS[(element as HTMLInputElement).type] ?? '输入框';
    default:
      return '控件';
  }
}

/** Text of a `<label>`, without the text of controls nested in it (e.g. a select's options). */
function labelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  copy.querySelectorAll('input, select, textarea, button').forEach((control) => control.remove());
  return clean(copy.textContent);
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
  const ariaLabel = clean(element.getAttribute('aria-label'));
  if (ariaLabel) return clip(ariaLabel, 40);

  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const field = element as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(field.type) && clean(field.value)) return clip(clean(field.value), 40);
    if (field.type === 'image' && clean(field.alt)) return clip(clean(field.alt), 40);
    const fromLabels = clean(Array.from(field.labels ?? []).map(labelText).join(' '));
    if (fromLabels) return clip(fromLabels, 40);
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
  }
  // Last resorts: an ID the setup Skill added, then the field's technical name.
  return clean(element.getAttribute('data-cue-id') ?? element.getAttribute('name'));
}

/** `按钮「保存」`: role and name, without any surrounding context. */
export function shortName(element: Element): string {
  const name = accessibleName(element);
  return name ? `${controlRole(element)}「${name}」` : controlRole(element);
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

export function dialogTitle(dialog: Element): string {
  const labelledBy = dialog.getAttribute('aria-labelledby');
  const byId = labelledBy ? dialog.ownerDocument.getElementById(labelledBy.split(/\s+/)[0] ?? '') : null;
  const heading = byId ?? dialog.querySelector('h1, h2, h3, h4, [role="heading"]');
  return clip(clean(dialog.getAttribute('aria-label')) || (heading ? textOf(heading) : '') || '未命名', 30);
}

function sameName(element: Element, name: string, role: string): number {
  if (!name) return 0;
  let count = 0;
  for (const other of Array.from(element.ownerDocument.querySelectorAll(CANDIDATE_SELECTOR))) {
    if (isInteractive(other) && controlRole(other) === role && accessibleName(other) === name && isVisible(other)) count++;
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
 * The full description used in the timeline: the short name, prefixed with the dialog it is in
 * and, when the same name appears more than once on the page, the row or section it belongs to.
 */
export function describeControl(element: Element): string {
  const role = controlRole(element);
  const name = accessibleName(element);
  const parts = [name ? `${role}「${name}」` : role];
  if (sameName(element, name, role) > 1) {
    const row = rowKey(element);
    const section = row ? undefined : headingNear(element);
    if (row) parts.unshift(`「${row}」这一行`);
    else if (section) parts.unshift(`「${section}」区域`);
  }
  const dialog = element.closest('[role="dialog"], [role="alertdialog"], dialog');
  if (dialog) parts.unshift(`弹窗「${dialogTitle(dialog)}」`);
  return parts.join(' › ');
}
